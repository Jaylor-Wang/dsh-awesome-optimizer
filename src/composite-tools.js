import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { normalizePath } from './runtime-policy.js';
import { buildEditFailureHint } from './edit-recovery.js';
import { truncateLongLines } from './read-guard.js';
import { selectReadWindows } from './find-read-ranking.js';
import {
  FindOutput, appendSearchNotices, searchStatus, splitWindows,
  readEvidenceBytes, collectReadSlice, appendReadSlices, appendMatchListing, finishFindOutput
} from './find-read-output.js';

export const FIND_AND_READ_TOOL = 'find_and_read';
export const EDIT_BATCH_TOOL = 'edit_batch';

export { truncateLongLines };

export const CompositeToolsConfig = z.object({
  enabled: z.boolean().default(true),
  findAndRead: z.boolean().default(true),
  editBatch: z.boolean().default(true),
  maxPatterns: z.number().step(1).min(1).max(10).default(5),
  defaultContextLines: z.number().step(1).min(0).max(25).default(5),
  maxFiles: z.number().step(1).min(1).max(12).default(5),
  maxWindows: z.number().step(1).min(1).max(25).default(10),
  maxWindowLines: z.number().step(1).min(1).max(1000).default(120),
  maxReadLines: z.number().step(1).min(1).max(10000).default(600),
  readConcurrency: z.number().step(1).min(1).max(8).default(3),
  experimentalReadRanges: z.boolean().default(false),
  maxBatchEdits: z.number().step(1).min(1).max(25).default(10),
  maxLineChars: z.number().step(1).min(100).max(50000).default(1500),
  maxTotalBytes: z.number().step(1).min(512).max(1024 * 1024).default(24576),
  atomicEdits: z.boolean().default(false)
});

/**
 * Parse DSH grouped grep output (`<path>\nLine N: text`), ripgrep `path:line:text`,
 * or structured `meta.matches` into flat `{ path, lineNumber, line }` records.
 */
export function parseGrepOutput(text, meta) {
  if (meta && (Array.isArray(meta.matches) || Array.isArray(meta.files))) {
    const structured = [
      ...(Array.isArray(meta.matches) ? meta.matches : []),
      ...(Array.isArray(meta.files) ? meta.files.flatMap(file =>
        Array.isArray(file?.matches) ? file.matches.map(match => ({ ...match, path: file.path })) : []
      ) : [])
    ];
    // Meta has its own retention cap; union with rendered text rather than hiding text-only hits.
    const matches = [...structured, ...parseGrepOutput(text)];
    const seen = new Set();
    return matches.filter(m => {
      if (!m || typeof m.path !== 'string' || !Number.isInteger(m.lineNumber) || m.lineNumber < 1) return false;
      const key = JSON.stringify([m.path, m.lineNumber]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(m => ({ path: m.path, lineNumber: m.lineNumber, line: String(m.line ?? '') }));
  }
  if (typeof text !== 'string' || !text.trim() || /^No matches found\b/i.test(text.trim())) {
    return [];
  }

  const matches = [];
  let currentFile = '';
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      currentFile = '';
      continue;
    }
    if (/^Found \d+ (?:of \d+ )?match(?:es)?$/i.test(trimmed)) continue;
    if (/^\((?:Full grep result stored at:|The complete result could not be saved)/.test(trimmed)) continue;

    // 1. Official DSH grouped line format: `Line 42: ...`
    const groupedLine = rawLine.match(/^Line (\d+):\s?(.*)$/);
    if (groupedLine && currentFile) {
      matches.push({
        path: currentFile,
        lineNumber: Number(groupedLine[1]),
        line: groupedLine[2]
      });
      continue;
    }

    // 2. Ripgrep flat format: `path:42:...` (supports Windows `C:\...`)
    const flatLine = rawLine.match(/^((?:[A-Za-z]:)?[^:\r\n]+):(\d+):(.*)$/);
    if (flatLine) {
      matches.push({
        path: flatLine[1],
        lineNumber: Number(flatLine[2]),
        line: flatLine[3]
      });
      continue;
    }

    // 3. Otherwise treat as current file group header
    currentFile = trimmed;
  }
  return matches;
}

/**
 * Merge nearby 1-based line numbers into disjoint `[start, end]` read windows.
 */
export function mergeMatchWindows(lineNumbers, contextLines = 5, adjacentGap = 2) {
  if (!Array.isArray(lineNumbers) || lineNumbers.length === 0) return [];
  const sorted = [...new Set(lineNumbers.filter(n => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const windows = [];
  for (const line of sorted) {
    const start = Math.max(1, line - contextLines);
    const end = line + contextLines;
    const prev = windows[windows.length - 1];
    if (prev && start <= prev.end + adjacentGap) {
      prev.end = Math.max(prev.end, end);
      prev.matchedLines.push(line);
    } else {
      windows.push({ start, end, matchedLines: [line] });
    }
  }
  return windows;
}

function stripReadEnvelope(rawText) {
  if (typeof rawText !== 'string') return '';
  let text = rawText;
  const envelope = text.match(/^[\s\S]*?<content>\n([\s\S]*)\n<\/content>[\s\S]*$/);
  if (envelope) {
    text = envelope[1];
  }
  text = text.replace(/\n\n\((?:Output capped\.|Showing lines |End of file )[^)]*\)\s*$/, '');
  return text.trimEnd();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}

async function readFileForPreflight(filePath, cwd, fsService, signal, resolvedTarget) {
  if (fsService) {
    // A service failure is authoritative; never bypass sandbox or cancellation through local disk.
    if (typeof fsService.readFile === 'function') {
      try {
        const content = await fsService.readFile(filePath, { cwd, signal, encoding: 'utf8' });
        return typeof content === 'string' ? { ok: true, content } : null;
      } catch (err) {
        return err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND'
          ? { ok: false, missing: true }
          : null;
      }
    }
    if (typeof fsService.readText === 'function') {
      try {
        const target = resolvedTarget ?? (typeof fsService.resolve === 'function'
          ? await fsService.resolve(filePath, { cwd, signal })
          : filePath);
        const content = await fsService.readText(target, signal);
        return typeof content === 'string' ? { ok: true, content } : null;
      } catch (err) {
        return err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND'
          ? { ok: false, missing: true }
          : null;
      }
    }
    return null;
  }

  // Standalone hosts without an fs service may use local preflight inspection.
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    const content = await fs.readFile(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return err?.code === 'ENOENT' ? { ok: false, missing: true } : null;
  }
}

function simulateEditsOnContent(initialContent, items, normalizeLineEndings = false) {
  const normalize = text => normalizeLineEndings ? text.replaceAll('\r\n', '\n') : text;
  let simulated = normalize(initialContent);
  for (const { index, item } of items) {
    const oldString = normalize(item.old_string);
    if (!oldString) {
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string must be non-empty.`
      };
    }
    const matches = countOccurrences(simulated, oldString);
    if (matches === 0) {
      const hint = buildEditFailureHint(simulated, item.old_string, { filePath: item.file_path });
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string not found (no changes written to this file).\n\n${hint}`
      };
    }
    if (!item.replace_all && matches > 1) {
      const hint = buildEditFailureHint(simulated, item.old_string, { filePath: item.file_path });
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string matched ${matches} locations; set replace_all=true or provide more context.\n\n${hint}`
      };
    }
    simulated = simulated.split(oldString).join(normalize(item.new_string));
  }
  return { ok: true };
}

function emptyStats() {
  return {
    findExecuted: 0,
    findPatternsSearched: 0,
    findWindowsRead: 0,
    findLinesRequested: 0,
    findReadBatches: 0,
    findFilesMatched: 0,
    editBatchesExecuted: 0,
    editsRequested: 0,
    editsSucceeded: 0,
    editsFailed: 0
  };
}

/**
 * Register precision composite tools:
 * - `find_and_read`: collapses multi-pattern grep + merged-window context reads into 1 round-trip
 * - `edit_batch`: sequential multi-edit with pre-flight simulation & recovery hints
 * Every sub-call routes through ToolExecutionPipeline so sandbox, permissions, and file observations hold.
 */
export function applyCompositeTools(ctx, rawConfig = {}) {
  const config = CompositeToolsConfig(rawConfig);
  if (!config.enabled) return null;

  const pipeline = new ToolExecutionPipeline(ctx);
  const statsBySession = new WeakMap();

  const stateFor = session => {
    if (!session) return null;
    let state = statsBySession.get(session);
    if (!state) {
      state = emptyStats();
      statsBySession.set(session, state);
    }
    return state;
  };

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      statsBySession.set(session, emptyStats());
    }
  });

  async function dispatchSubCall(exec, toolName, subArgs, subCallId) {
    const session = exec.agent?.session;
    const log = {
      rootCallId: exec.rootCallId,
      parentCallId: exec.callId,
      subCallId,
      name: toolName,
      arguments: subArgs
    };
    if (session?.append) {
      session.append('tool/ptc-dispatch-start', log);
    }
    const prepared = await pipeline.prepare({
      callId: subCallId,
      rootCallId: exec.rootCallId,
      parent: exec.token,
      name: toolName,
      arguments: subArgs,
      agent: exec.agent,
      toolSet: exec.toolSet,
      signal: exec.signal
    });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    const result = await pipeline.complete(prepared.exec, outcome);
    if (session?.append) {
      session.append('tool/ptc-dispatch', {
        ...log,
        isError: result.isError,
        content: result.content,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta === undefined ? {} : { meta: result.meta })
      });
    }
    for (const context of result.additionalContexts ?? []) {
      exec.deferContext(context);
    }
    return result;
  }

  async function readBatch(exec, batch) {
    const nativeRead = async task => {
      exec.signal.throwIfAborted();
      const result = await dispatchSubCall(exec, 'read', {
        file_path: task.file.displayPath, offset: task.win.start, limit: task.win.end - task.win.start + 1
      }, `${exec.callId}:find-read-${task.index}`);
      const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      return result.isError ? { error: result.error?.message ?? text } : { text: stripReadEnvelope(text) };
    };
    const capability = config.experimentalReadRanges && ctx.get('optimizerReadRanges');
    if (capability?.version !== 1 || !ctx.tools.executable('read', exec.agent, exec.toolSet) ||
        !ctx.tools.executable('optimizer_read_ranges', exec.agent, exec.toolSet)) {
      return Promise.all(batch.map(nativeRead));
    }

    const groups = new Map();
    for (const task of batch) {
      const group = groups.get(task.file) ?? [];
      group.push(task);
      groups.set(task.file, group);
    }
    const byIndex = new Map();
    await Promise.all([...groups.values()].map(async group => {
      const first = group[0];
      if (group.length === 1) {
        byIndex.set(first.index, await nativeRead(first));
        return;
      }
      exec.signal.throwIfAborted();
      const result = await dispatchSubCall(exec, 'optimizer_read_ranges', {
        file_path: first.file.displayPath,
        ranges: group.map(({ win }) => ({ offset: win.start, limit: win.end - win.start + 1 }))
      }, `${exec.callId}:find-ranges-${first.index}`);
      const blocks = result.content ?? [];
      const valid = blocks.length === group.length && blocks.every(b => b.type === 'text');
      const error = result.isError
        ? blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Multi-window read failed.'
        : 'Multi-window read returned no usable windows.';
      for (const [i, task] of group.entries()) {
        // Post-execute can replace content while leaving the original value and meta intact.
        byIndex.set(task.index, !result.isError && valid ? { text: blocks[i].text.trimEnd() } : { error });
      }
    }));
    return batch.map(task => byIndex.get(task.index));
  }

  if (config.findAndRead) {
    ctx.tools.register({
      name: FIND_AND_READ_TOOL,
      description: [
        `Search code with 1 to ${config.maxPatterns} regex patterns and return merged, line-numbered context slices around matches in a single round-trip.`,
        'Replaces sequential grep -> read loops while capping total output bytes.',
        'Set contextLines=0 for a deduplicated match-only listing.'
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: {
            type: 'string',
            description: 'Single ripgrep regex pattern to search for.'
          },
          patterns: {
            type: 'array',
            minItems: 1,
            maxItems: config.maxPatterns,
            items: { type: 'string' },
            description: `1 to ${config.maxPatterns} ripgrep regex patterns searched in parallel and aggregated.`
          },
          path: {
            type: 'string',
            description: 'Directory or file to search. Defaults to the session workspace.'
          },
          include: {
            type: 'string',
            description: 'One positive glob filter for files (e.g. "*.ts", "*.{js,jsx}").'
          },
          contextLines: {
            type: 'number',
            description: `Lines before and after each match (0-25). Defaults to ${config.defaultContextLines}.`
          },
          maxFiles: {
            type: 'number',
            description: `Maximum files to return code slices for (1-12). Defaults to ${config.maxFiles}.`
          },
          maxWindows: {
            type: 'number',
            description: `Maximum merged context windows to read (1-25). Defaults to ${config.maxWindows}.`
          }
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const rawPatterns = [
          ...(typeof args?.pattern === 'string' ? [args.pattern] : []),
          ...(Array.isArray(args?.patterns) ? args.patterns : [])
        ].filter(p => typeof p === 'string' && p.length > 0);

        const uniquePatterns = [...new Set(rawPatterns)];
        if (uniquePatterns.length === 0) {
          throw new HarnessError('find_and_read requires a non-empty "pattern" or "patterns" array.', 'INVALID_FIND_AND_READ_ARGS');
        }
        if (uniquePatterns.length > config.maxPatterns) {
          throw new HarnessError(
            `find_and_read received ${uniquePatterns.length} patterns, exceeding maxPatterns (${config.maxPatterns}).`,
            'FIND_AND_READ_LIMIT_EXCEEDED'
          );
        }

        const contextLines = typeof args?.contextLines === 'number' && Number.isFinite(args.contextLines)
          ? Math.max(0, Math.min(25, Math.floor(args.contextLines)))
          : config.defaultContextLines;
        const maxFiles = typeof args?.maxFiles === 'number' && Number.isFinite(args.maxFiles)
          ? Math.max(1, Math.min(12, Math.floor(args.maxFiles)))
          : config.maxFiles;
        const maxWindows = typeof args?.maxWindows === 'number' && Number.isFinite(args.maxWindows)
          ? Math.max(1, Math.min(25, Math.floor(args.maxWindows)))
          : config.maxWindows;

        const session = exec.agent?.session;
        const state = stateFor(session);
        const cwdService = ctx.get ? ctx.get('workingDirectory') : undefined;
        const cwd = cwdService?.get?.(session) ?? '';

        if (state) {
          state.findExecuted++;
          state.findPatternsSearched += uniquePatterns.length;
        }

        const grepRuns = await Promise.all(uniquePatterns.map(async (pattern, idx) => {
          exec.signal.throwIfAborted();
          const grepArgs = {
            pattern,
            ...(typeof args?.path === 'string' && args.path.trim() ? { path: args.path } : {}),
            ...(typeof args?.include === 'string' && args.include.trim() ? { include: args.include } : {})
          };
          const result = await dispatchSubCall(exec, 'grep', grepArgs, `${exec.callId}:find-grep-${idx}`);
          return { pattern, result };
        }));

        const runs = grepRuns.map(({ pattern, result }, index) => {
          const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          const parsed = result.isError ? [] : parseGrepOutput(text, result.meta);
          return { pattern, result, index, text, parsed, status: searchStatus(text, result.meta, parsed.length) };
        });
        const output = new FindOutput(config.maxTotalBytes);
        appendSearchNotices(output, runs);
        if (runs.every(run => run.result.isError)) {
          throw new HarnessError(output.finish('All grep patterns failed.'), 'FIND_AND_READ_GREP_FAILED');
        }

        // Aggregate and deduplicate matches by normalized file path + line number
        const filesMap = new Map();
        let firstSeenOrder = 0;

        for (const { pattern, result, parsed } of runs) {
          if (result.isError) continue;
          for (const m of parsed) {
            const norm = normalizePath(m.path, cwd) || m.path;
            let entry = filesMap.get(norm);
            if (!entry) {
              entry = {
                displayPath: m.path,
                sortPath: norm,
                linePatterns: new Map(),
                order: firstSeenOrder++,
                patterns: new Set(),
                lines: new Map(),
                shown: new Set()
              };
              filesMap.set(norm, entry);
            }
            entry.patterns.add(pattern);
            if (!entry.linePatterns.has(m.lineNumber)) entry.linePatterns.set(m.lineNumber, new Set());
            entry.linePatterns.get(m.lineNumber).add(pattern);
            if (!entry.lines.has(m.lineNumber)) {
              entry.lines.set(m.lineNumber, m.line);
            }
          }
        }

        if (filesMap.size === 0) {
          const incomplete = runs.some(run => run.result.isError || run.status.truncated);
          output.appendClipped(`${incomplete ? 'No retained matches available' : 'No matches found'} for pattern(s): ${uniquePatterns.join(', ')}`);
          return output.finish(output.reduced ? '[Query text truncated to fit byte budget.]' : '');
        }

        if (state) {
          state.findFilesMatched += filesMap.size;
        }

        // Rank files by distinct pattern coverage first, then match count, then discovery order
        const rankedFiles = [...filesMap.values()].sort((a, b) =>
          (b.patterns.size - a.patterns.size)
          || (Math.min(10, b.lines.size) - Math.min(10, a.lines.size))
          || (a.order - b.order)
        );

        output.append(`Found retained matches across ${filesMap.size} file(s):`);
        const canRead = contextLines > 0 && ctx.tools.get('read', exec.agent) !== undefined;
        if (!canRead) {
          appendMatchListing(output, rankedFiles, config.maxLineChars);
          return finishFindOutput(output, rankedFiles);
        }

        const candidates = rankedFiles.flatMap(file =>
          splitWindows(mergeMatchWindows([...file.lines.keys()], contextLines), config.maxWindowLines)
            .map(win => ({ file, win }))
        );
        const chosenTasks = selectReadWindows(candidates, { maxFiles, maxWindows, maxReadLines: config.maxReadLines });

        // Admit reads by their evidence cost. Context is optional and cannot consume later reads' budget.
        const slices = [];
        let evidenceBytes = output.remaining();
        let cursor = 0;
        while (cursor < chosenTasks.length && evidenceBytes > 0) {
          exec.signal.throwIfAborted();
          const batch = [];
          while (cursor < chosenTasks.length && batch.length < config.readConcurrency) {
            const task = chosenTasks[cursor];
            const cost = readEvidenceBytes(task, config.maxLineChars);
            if (cost <= evidenceBytes) {
              batch.push({ ...task, index: cursor });
              evidenceBytes -= cost;
            }
            cursor++;
          }
          if (!batch.length) break;
          if (state) {
            state.findReadBatches++;
            state.findWindowsRead += batch.length;
            state.findLinesRequested += batch.reduce((sum, task) => sum + task.win.end - task.win.start + 1, 0);
          }
          const readResults = await readBatch(exec, batch);
          exec.signal.throwIfAborted();
          for (const [index, item] of readResults.entries()) {
            slices.push(collectReadSlice(batch[index], item.text ?? '', config.maxLineChars, item.error));
          }
        }
        appendReadSlices(output, slices);
        return finishFindOutput(output, rankedFiles);
      }
    }, { when: ({ agent }) => ctx.tools.get('grep', agent) !== undefined });
  }

  if (config.editBatch) {
    ctx.tools.register({
      name: EDIT_BATCH_TOOL,
      description: [
        `Apply multiple targeted literal text edits (up to ${config.maxBatchEdits}) in a single file or across multiple files in a single tool call.`,
        'Edits execute sequentially through the native edit tool pipeline with full sandbox, observation policy, and mutation checks.',
        'Useful for multi-file refactoring or multi-location revisions without sequential single-edit round trips.'
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['edits'],
        properties: {
          atomic: {
            type: 'boolean',
            description: `Require successful preflight of every edit before writing; cannot be combined with sandbox_permissions. Once execution starts, stop on the first failure without rolling back applied edits. Not a transaction. Defaults to ${config.atomicEdits}.`
          },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: config.maxBatchEdits,
            description: `List of literal text edits (1 to ${config.maxBatchEdits} edits) to apply sequentially in a single file or across multiple files.`,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file_path', 'old_string', 'new_string'],
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.'
                },
                old_string: {
                  type: 'string',
                  description: 'Literal text to replace.'
                },
                new_string: {
                  type: 'string',
                  description: 'Literal replacement text. Use an empty string to delete the match.'
                },
                replace_all: {
                  type: 'boolean',
                  description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.'
                },
                justification: {
                  type: 'string',
                  description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact edit needs the wider access.'
                },
                sandbox_permissions: {
                  type: 'string',
                  enum: ['workspace-write', 'danger-full-access'],
                  description: 'The narrowest wider sandbox mode for a one-shot retry of the exact edit the sandbox just denied.'
                }
              }
            }
          }
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        if (edits.length === 0) {
          throw new HarnessError('edit_batch requires at least one edit entry in "edits".', 'INVALID_EDIT_BATCH_ARGS');
        }
        if (edits.length > config.maxBatchEdits) {
          throw new HarnessError(
            `edit_batch received ${edits.length} edits, exceeding maxBatchEdits (${config.maxBatchEdits}).`,
            'EDIT_BATCH_LIMIT_EXCEEDED'
          );
        }

        const isAtomic = typeof args?.atomic === 'boolean' ? args.atomic : config.atomicEdits;
        const session = exec.agent?.session;
        const state = stateFor(session);
        if (state) {
          state.editBatchesExecuted++;
          state.editsRequested += edits.length;
        }

        const fsService = ctx.get ? ctx.get('fs') : undefined;
        const cwdService = ctx.get ? ctx.get('workingDirectory') : undefined;
        const cwd = cwdService?.get?.(session) ?? '';

        const editsByPath = new Map();
        const preflightBlockedPaths = new Map();
        const invalidEntries = new Map();
        const targetsByPath = new Map();
        const pathKeys = new Map();

        for (let index = 0; index < edits.length; index++) {
          const item = edits[index];
          if (!item || typeof item.file_path !== 'string' || !item.file_path.trim() || typeof item.old_string !== 'string' || typeof item.new_string !== 'string') {
            invalidEntries.set(index, 'Invalid edit entry: file_path, old_string, and new_string must be strings.');
            continue;
          }
          if (!item.old_string || item.old_string === item.new_string) {
            invalidEntries.set(index, 'Invalid edit entry: old_string must be non-empty and differ from new_string.');
            continue;
          }
          let pathKey = normalizePath(item.file_path, cwd) || item.file_path.trim();
          let target;
          if (isAtomic) {
            if (typeof item.sandbox_permissions === 'string') {
              invalidEntries.set(index, 'Strict preflight is incompatible with sandbox_permissions. No approval was requested.');
              continue;
            }
            if (typeof item.justification === 'string') {
              invalidEntries.set(index, 'justification requires sandbox_permissions, which strict preflight does not accept.');
              continue;
            }
            exec.signal.throwIfAborted();
            if (!targetsByPath.has(item.file_path)) {
              try {
                target = await fsService?.resolve?.(item.file_path, { cwd, signal: exec.signal });
              } catch (error) {
                exec.signal.throwIfAborted();
                if (error?.code === 'ENOENT' || error?.code === 'FS_NOT_FOUND') {
                  invalidEntries.set(index, 'Pre-flight failed: target file does not exist.');
                  continue;
                }
              }
              targetsByPath.set(item.file_path, target);
            }
            target = targetsByPath.get(item.file_path);
            if (typeof target?.targetKey !== 'string' || !target.targetKey) {
              invalidEntries.set(index, 'Pre-flight could not verify the target identity through the native filesystem service.');
              continue;
            }
            pathKey = target.targetKey;
          }
          pathKeys.set(index, pathKey);
          if (!editsByPath.has(pathKey)) editsByPath.set(pathKey, []);
          editsByPath.get(pathKey).push({ index, item, target });
        }

        for (const [pathKey, group] of editsByPath.entries()) {
          const shouldPreflight = isAtomic || group.length > 1;
          if (!shouldPreflight) continue;
          if (group.some(({ item }) => typeof item.sandbox_permissions === 'string')) continue;

          // Resolve aliases to one simulation, but require each distinct path to be readable.
          const inputs = isAtomic
            ? new Map(group.map(entry => [entry.item.file_path, entry.target]))
            : new Map([[group[0].item.file_path, undefined]]);
          let content;
          for (const [filePath, target] of inputs) {
            exec.signal.throwIfAborted();
            const probe = await readFileForPreflight(filePath, cwd, fsService, exec.signal, target);
            exec.signal.throwIfAborted();
            if (probe?.missing) {
              preflightBlockedPaths.set(pathKey, `Pre-flight failed (${filePath}): target file does not exist (no changes written).`);
              break;
            }
            if (!probe?.ok || (content !== undefined && probe.content !== content)) {
              if (isAtomic) {
                preflightBlockedPaths.set(pathKey, `Pre-flight could not verify a readable, consistent snapshot for ${filePath} (no edits dispatched).`);
              }
              break;
            }
            content = probe.content;
          }
          if (content !== undefined && !preflightBlockedPaths.has(pathKey)) {
            const sim = simulateEditsOnContent(content, group, isAtomic);
            if (!sim.ok) preflightBlockedPaths.set(pathKey, sim.reason);
          }
        }

        if (isAtomic && (invalidEntries.size > 0 || preflightBlockedPaths.size > 0)) {
          if (state) state.editsFailed += edits.length;
          const reasons = [];
          for (const [index, msg] of invalidEntries.entries()) {
            reasons.push(`=== [ERROR] ${String(edits[index]?.file_path ?? `<invalid-${index}>`)} ===\n[ERROR] ${msg}`);
          }
          for (const [, reason] of preflightBlockedPaths.entries()) {
            reasons.push(`=== [ERROR] Pre-flight ===\n[ERROR] ${reason}`);
          }
          throw new HarnessError(
            `${reasons.join('\n\n')}\n\n[Atomic edit_batch aborted before any file was modified.]`,
            'EDIT_BATCH_PREFLIGHT_FAILED'
          );
        }

        const failedPaths = new Set();
        const subResults = [];
        let stoppedAt = null;
        let applied = 0;

        for (let index = 0; index < edits.length; index++) {
          const item = edits[index];
          if (exec.signal.aborted) {
            if (applied === 0) exec.signal.throwIfAborted();
            if (state) state.editsFailed++;
            subResults.push({
              filePath: item?.file_path ?? `<invalid-${index}>`,
              isError: true,
              text: `[ERROR] Skipped edit #${index + 1}: batch cancelled.`
            });
            continue;
          }
          if (invalidEntries.has(index)) {
            if (state) state.editsFailed++;
            subResults.push({
              filePath: String(item?.file_path ?? `<invalid-${index}>`),
              isError: true,
              text: `[ERROR] ${invalidEntries.get(index)}`
            });
            continue;
          }

          if (stoppedAt !== null) {
            if (state) state.editsFailed++;
            subResults.push({
              filePath: item.file_path,
              isError: true,
              text: `[ERROR] Skipped edit #${index + 1}: strict batch stopped after edit #${stoppedAt} failed.`
            });
            continue;
          }
          const pathKey = pathKeys.get(index);
          if (preflightBlockedPaths.has(pathKey)) {
            if (state) state.editsFailed++;
            subResults.push({
              filePath: item.file_path,
              isError: true,
              text: `[ERROR] ${preflightBlockedPaths.get(pathKey)}`
            });
            continue;
          }

          if (failedPaths.has(pathKey)) {
            if (state) state.editsFailed++;
            subResults.push({
              filePath: item.file_path,
              isError: true,
              text: `[ERROR] Skipped edit #${index + 1} after an earlier failure on ${item.file_path} to prevent partial corruption.`
            });
            continue;
          }

          const editArgs = {
            file_path: item.file_path,
            old_string: item.old_string,
            new_string: item.new_string,
            ...(typeof item.replace_all === 'boolean' ? { replace_all: item.replace_all } : {}),
            ...(typeof item.justification === 'string' ? { justification: item.justification } : {}),
            ...(typeof item.sandbox_permissions === 'string' ? { sandbox_permissions: item.sandbox_permissions } : {})
          };

          const result = await dispatchSubCall(exec, 'edit', editArgs, `${exec.callId}:edit-batch-${index}`);
          if (result.isError) {
            if (state) state.editsFailed++;
            if (isAtomic) stoppedAt = index + 1;
            failedPaths.add(pathKey);
            const msg = result.error?.message
              ?? result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
              ?? 'Edit failed';
            subResults.push({
              filePath: item.file_path,
              isError: true,
              text: `[ERROR] ${msg}`
            });
          } else {
            applied++;
            if (state) state.editsSucceeded++;
            const text = (result.content ?? [])
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n') || `Edited ${item.file_path}`;
            subResults.push({
              filePath: item.file_path,
              isError: false,
              text
            });
          }
        }

        const notApplied = edits.length - applied;
        const rendered = subResults
          .map(entry => `=== [${entry.isError ? 'ERROR' : 'EDIT'}] ${entry.filePath} ===\n${entry.text}`)
          .join('\n\n');

        if (applied === 0) throw new HarnessError(rendered, 'EDIT_BATCH_ALL_FAILED');
        if (notApplied > 0) {
          const message = `[PARTIAL] edit_batch: ${applied}/${edits.length} edits succeeded; ${notApplied} failed or were skipped. Applied edits were not rolled back. Do not retry the entire batch.\n\n${rendered}`;
          // Preserve best-effort success semantics; strict batches signal failure to the caller.
          if (isAtomic || exec.signal.aborted) throw new HarnessError(message, 'EDIT_BATCH_PARTIAL');
          return message;
        }
        return rendered;
      }
    }, { when: ({ agent }) => ctx.tools.get('edit', agent) !== undefined });
  }

  return {
    getStats(session) {
      const s = session ? statsBySession.get(session) : null;
      return s ? { ...s } : emptyStats();
    }
  };
}

export const name = 'agent-optimizer-composite-tools';
export const inject = ['tools'];
export const Config = CompositeToolsConfig;
export function apply(ctx, config = {}) {
  const service = applyCompositeTools(ctx, config);
  if (service) ctx.provide('compositeTools', service);
}
export default { name, inject, Config, apply };
