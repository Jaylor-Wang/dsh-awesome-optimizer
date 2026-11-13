import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { normalizePath } from './runtime-policy.js';
import { buildEditFailureHint } from './edit-recovery.js';
import { truncateLongLines } from './read-guard.js';

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
  if (meta && Array.isArray(meta.matches)) {
    return meta.matches
      .filter(m => m && typeof m.path === 'string' && Number.isInteger(m.lineNumber) && m.lineNumber >= 1)
      .map(m => ({ path: m.path, lineNumber: m.lineNumber, line: String(m.line ?? '') }));
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

function formatSliceText(sliceText, matchedLines, maxLineChars) {
  const matchedSet = new Set(matchedLines);
  const capped = truncateLongLines(sliceText, maxLineChars);
  return capped
    .split('\n')
    .map(line => {
      const m = line.match(/^(\d+):\s?(.*)$/);
      if (!m) return `  ${line}`;
      const lineNum = Number(m[1]);
      return `${matchedSet.has(lineNum) ? '>' : ' '} ${line}`;
    })
    .join('\n');
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

async function readFileForPreflight(filePath, cwd, fsService, signal) {
  if (fsService) {
    if (typeof fsService.readFile === 'function') {
      try {
        const content = await fsService.readFile(filePath, { cwd, signal });
        if (typeof content === 'string') return { ok: true, content };
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: false, missing: true };
      }
    }
    if (typeof fsService.readText === 'function') {
      try {
        const target = typeof fsService.resolve === 'function'
          ? await fsService.resolve(filePath, { cwd, signal })
          : filePath;
        const content = await fsService.readText(target, signal);
        if (typeof content === 'string') return { ok: true, content };
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND') return { ok: false, missing: true };
      }
    }
  }

  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    const content = await fs.readFile(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (fsService && typeof fsService.resolve === 'function' && typeof fsService.stat === 'function') {
        try {
          const target = await fsService.resolve(filePath, { cwd, signal });
          const stat = await fsService.stat(target, signal);
          if (stat) return null;
        } catch {
          // ignore
        }
      }
      return { ok: false, missing: true };
    }
    return null;
  }
}

function simulateEditsOnContent(initialContent, items) {
  let simulated = initialContent;
  for (const { index, item } of items) {
    if (!item.old_string) {
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string must be non-empty.`
      };
    }
    const matches = countOccurrences(simulated, item.old_string);
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
    simulated = item.replace_all
      ? simulated.split(item.old_string).join(item.new_string)
      : simulated.replace(item.old_string, item.new_string);
  }
  return { ok: true };
}

function emptyStats() {
  return {
    findExecuted: 0,
    findPatternsSearched: 0,
    findWindowsRead: 0,
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
        ].map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);

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

        const allGrepErrored = grepRuns.every(r => r.result.isError);
        if (allGrepErrored) {
          const errors = grepRuns.map(({ pattern, result }) => {
            const msg = result.error?.message
              ?? result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
              ?? 'grep failed';
            return `[${pattern}] ${msg}`;
          }).join('\n');
          throw new HarnessError(errors, 'FIND_AND_READ_GREP_FAILED');
        }

        // Aggregate and deduplicate matches by normalized file path + line number
        const filesMap = new Map();
        const grepWarnings = [];
        let firstSeenOrder = 0;

        for (const { pattern, result } of grepRuns) {
          if (result.isError) {
            const msg = result.error?.message
              ?? result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
              ?? 'grep error';
            grepWarnings.push(`Pattern "${pattern}" failed: ${msg}`);
            continue;
          }
          const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          const parsed = parseGrepOutput(text, result.meta);
          for (const m of parsed) {
            const norm = normalizePath(m.path, cwd) || m.path;
            let entry = filesMap.get(norm);
            if (!entry) {
              entry = {
                displayPath: m.path,
                order: firstSeenOrder++,
                patterns: new Set(),
                lines: new Map()
              };
              filesMap.set(norm, entry);
            }
            entry.patterns.add(pattern);
            if (!entry.lines.has(m.lineNumber)) {
              entry.lines.set(m.lineNumber, m.line);
            }
          }
        }

        if (filesMap.size === 0) {
          const base = `No matches found for pattern(s): ${uniquePatterns.join(', ')}`;
          return grepWarnings.length > 0 ? `${base}\n\n${grepWarnings.join('\n')}` : base;
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

        const canRead = contextLines > 0 && ctx.tools.get('read', exec.agent) !== undefined;
        if (!canRead) {
          const sections = [];
          let usedBytes = 0;
          let omitted = 0;
          for (const file of rankedFiles) {
            const rows = [...file.lines.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([ln, lineText]) => `  ${ln}: ${truncateLongLines(lineText, config.maxLineChars)}`);
            const block = `=== ${file.displayPath} (${file.lines.size} matches) ===\n${rows.join('\n')}`;
            const bLen = Buffer.byteLength(block, 'utf8') + 2;
            if (usedBytes + bLen <= config.maxTotalBytes) {
              sections.push(block);
              usedBytes += bLen;
            } else {
              omitted++;
            }
          }
          if (omitted > 0) {
            sections.push(`[find_and_read budget: omitted ${omitted} additional matched file(s) to stay within maxTotalBytes=${config.maxTotalBytes}]`);
          }
          if (grepWarnings.length > 0) sections.push(grepWarnings.join('\n'));
          return sections.join('\n\n');
        }

        // Build merged windows per top file and select round-robin up to maxWindows
        const selectedFiles = rankedFiles.slice(0, maxFiles);
        const fileWindows = selectedFiles.map(file => ({
          file,
          windows: mergeMatchWindows([...file.lines.keys()], contextLines),
          cursor: 0
        }));

        const chosenTasks = [];
        let progress = true;
        while (chosenTasks.length < maxWindows && progress) {
          progress = false;
          for (const fw of fileWindows) {
            if (chosenTasks.length >= maxWindows) break;
            if (fw.cursor < fw.windows.length) {
              chosenTasks.push({ file: fw.file, win: fw.windows[fw.cursor++] });
              progress = true;
            }
          }
        }

        if (state) {
          state.findWindowsRead += chosenTasks.length;
        }

        const readResults = await Promise.all(chosenTasks.map(async (task, idx) => {
          exec.signal.throwIfAborted();
          const limit = task.win.end - task.win.start + 1;
          const result = await dispatchSubCall(
            exec,
            'read',
            { file_path: task.file.displayPath, offset: task.win.start, limit },
            `${exec.callId}:find-read-${idx}`
          );
          return { ...task, result };
        }));

        const renderedBlocks = [];
        const overflowIndex = [];
        let usedBytes = 0;

        for (const item of readResults) {
          let block;
          if (item.result.isError) {
            const msg = item.result.error?.message
              ?? item.result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
              ?? 'Read failed';
            block = `=== ${item.file.displayPath}:${item.win.start}-${item.win.end} [READ ERROR] ===\n${msg}`;
          } else {
            const rawText = (item.result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
            const cleanText = stripReadEnvelope(rawText);
            const formatted = formatSliceText(cleanText, item.win.matchedLines, config.maxLineChars);
            block = `=== ${item.file.displayPath}:${item.win.start}-${item.win.end} ===\n${formatted}`;
          }

          const bytes = Buffer.byteLength(block, 'utf8') + 2;
          if (renderedBlocks.length === 0 || usedBytes + bytes <= config.maxTotalBytes) {
            renderedBlocks.push(block);
            usedBytes += bytes;
          } else {
            overflowIndex.push(`${item.file.displayPath}: L${item.win.matchedLines.join(', L')}`);
          }
        }

        // Index any windows/files skipped due to maxWindows or maxFiles
        for (const fw of fileWindows) {
          for (let i = fw.cursor; i < fw.windows.length; i++) {
            overflowIndex.push(`${fw.file.displayPath}: L${fw.windows[i].matchedLines.join(', L')}`);
          }
        }
        for (let i = maxFiles; i < rankedFiles.length; i++) {
          const f = rankedFiles[i];
          const lineList = [...f.lines.keys()].sort((a, b) => a - b).slice(0, 6);
          const suffix = f.lines.size > 6 ? `, ... (${f.lines.size} total)` : '';
          overflowIndex.push(`${f.displayPath}: L${lineList.join(', L')}${suffix}`);
        }

        const header = `Found matches across ${filesMap.size} file(s) (showing ${renderedBlocks.length} merged slice(s)):`;
        const parts = [header, ...renderedBlocks];
        if (overflowIndex.length > 0) {
          parts.push(`--- Additional matches (index only) ---\n${overflowIndex.join('\n')}`);
        }
        if (grepWarnings.length > 0) {
          parts.push(grepWarnings.join('\n'));
        }
        return parts.join('\n\n');
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
            description: `When true, pre-flight validate all edits and abort without writing if any edit fails. Defaults to ${config.atomicEdits}.`
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

        for (let index = 0; index < edits.length; index++) {
          const item = edits[index];
          if (!item || typeof item.file_path !== 'string' || !item.file_path.trim() || typeof item.old_string !== 'string' || typeof item.new_string !== 'string') {
            invalidEntries.set(index, 'Invalid edit entry: file_path, old_string, and new_string must be strings.');
            continue;
          }
          const pathKey = normalizePath(item.file_path, cwd) || item.file_path.trim();
          if (!editsByPath.has(pathKey)) editsByPath.set(pathKey, []);
          editsByPath.get(pathKey).push({ index, item });
        }

        for (const [pathKey, group] of editsByPath.entries()) {
          const shouldPreflight = isAtomic || group.length > 1;
          if (!shouldPreflight) continue;
          if (group.some(({ item }) => typeof item.sandbox_permissions === 'string')) continue;

          const probe = await readFileForPreflight(group[0].item.file_path, cwd, fsService, exec.signal);
          if (!probe) continue;
          if (!probe.ok && probe.missing) {
            preflightBlockedPaths.set(
              pathKey,
              `Pre-flight failed (${group[0].item.file_path}): target file does not exist (no changes written).`
            );
            continue;
          }
          if (probe.ok) {
            const sim = simulateEditsOnContent(probe.content, group);
            if (!sim.ok) {
              preflightBlockedPaths.set(pathKey, sim.reason);
            }
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

        const failedPaths = new Set(preflightBlockedPaths.keys());
        const subResults = [];

        for (let index = 0; index < edits.length; index++) {
          exec.signal.throwIfAborted();
          const item = edits[index];
          if (invalidEntries.has(index)) {
            if (state) state.editsFailed++;
            subResults.push({
              filePath: String(item?.file_path ?? `<invalid-${index}>`),
              isError: true,
              text: `[ERROR] ${invalidEntries.get(index)}`
            });
            continue;
          }

          const pathKey = normalizePath(item.file_path, cwd) || item.file_path.trim();
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

        const allFailed = subResults.every(entry => entry.isError);
        const rendered = subResults
          .map(entry => `=== [${entry.isError ? 'ERROR' : 'EDIT'}] ${entry.filePath} ===\n${entry.text}`)
          .join('\n\n');

        if (allFailed) {
          throw new HarnessError(rendered, 'EDIT_BATCH_ALL_FAILED');
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
