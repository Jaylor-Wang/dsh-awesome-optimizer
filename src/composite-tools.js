import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { normalizePath } from './runtime-policy.js';
import { truncateLongLines } from './read-guard.js';
import { getWorkingDirectory } from './fs-preflight.js';
import { EDIT_BATCH_TOOL, registerEditBatchTool } from './edit-batch.js';
import { selectReadWindows } from './find-read-ranking.js';
import {
  FindOutput, appendSearchNotices, searchStatus, splitWindows,
  readEvidenceBytes, collectReadSlice, appendReadSlices, appendMatchListing, finishFindOutput
} from './find-read-output.js';

export const FIND_AND_READ_TOOL = 'find_and_read';
export { EDIT_BATCH_TOOL, truncateLongLines };

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
  maxBatchEdits: z.number().step(1).min(1).max(25).default(10),
  maxLineChars: z.number().step(1).min(100).max(50000).default(1500),
  maxTotalBytes: z.number().step(1).min(512).max(1024 * 1024).default(24576),
  maxPreflightBytes: z.number().step(1).min(4096).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
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
      const canonicalPath = normalizePath(m.path) || m.path;
      const key = JSON.stringify([canonicalPath, m.lineNumber]);
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

  async function dispatchSubBatch(exec, calls, maxParallel) {
    const session = exec.agent?.session;
    const rootCallId = exec.rootCallId ?? exec.callId;
    const nested = input => ({ ...input, rootCallId, parent: exec.token });
    const audit = input => ({
      rootCallId, parentCallId: exec.callId, subCallId: input.callId,
      name: input.name, arguments: input.arguments
    });

    // The host scheduler owns admission order, exclusive barriers, cancellation and completion.
    // Adapt only the nested identity and event format (root step logging stays disabled).
    const stages = {
      executionMode: input => pipeline.executionMode(nested(input)),
      prepare(input) {
        session?.append?.('tool/ptc-dispatch-start', audit(input));
        return pipeline.prepare(nested(input));
      },
      dispatch: input => pipeline.dispatch(input),
      async complete(input, outcome) {
        const result = await pipeline.complete(input, outcome);
        session?.append?.('tool/ptc-dispatch', {
          ...audit(input),
          isError: result.isError,
          content: result.content,
          ...(result.error?.info ? { error: result.error.info } : {}),
          ...(result.meta === undefined ? {} : { meta: result.meta })
        });
        for (const context of result.additionalContexts ?? []) exec.deferContext(context);
        return result;
      }
    };
    const batch = await executeToolBatch({
      calls, agent: exec.agent, toolSet: exec.toolSet, signal: exec.signal,
      maxParallelToolCalls: maxParallel
    }, stages, () => maxParallel);
    return batch.results.map(entry => entry.result);
  }

  function subCall(id, name, args) {
    return { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
  }

  async function dispatchSubCall(exec, toolName, subArgs, subCallId) {
    const [result] = await dispatchSubBatch(exec, [subCall(subCallId, toolName, subArgs)], 1);
    return result;
  }

  async function readBatch(exec, batch) {
    const calls = batch.map(task => subCall(`${exec.callId}:find-read-${task.index}`, 'read', {
      file_path: task.file.displayPath, offset: task.win.start, limit: task.win.end - task.win.start + 1
    }));
    const results = await dispatchSubBatch(exec, calls, config.readConcurrency);
    return results.map(result => {
      const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      return result.isError ? { error: result.error?.message ?? text } : { text: stripReadEnvelope(text) };
    });
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
            description: `1 to ${config.maxPatterns} ripgrep regex patterns, searched concurrently when the registered grep tool allows it.`
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
      // Scoped replacements may be exclusive. The root classifier has no agent or tool set.
      isConcurrencySafe: () => false,
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
        const cwd = getWorkingDirectory(ctx, session);

        if (state) {
          state.findExecuted++;
          state.findPatternsSearched += uniquePatterns.length;
        }

        const grepCalls = uniquePatterns.map((pattern, index) => subCall(`${exec.callId}:find-grep-${index}`, 'grep', {
          pattern,
          ...(typeof args?.path === 'string' && args.path.trim() ? { path: args.path } : {}),
          ...(typeof args?.include === 'string' && args.include.trim() ? { include: args.include } : {})
        }));
        const grepResults = await dispatchSubBatch(exec, grepCalls, config.maxPatterns);
        exec.signal.throwIfAborted();

        const runs = grepResults.map((result, index) => {
          const pattern = uniquePatterns[index];
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
        const canRead = contextLines > 0 && ctx.tools.get('read', exec.agent, exec.toolSet) !== undefined;
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
    registerEditBatchTool(ctx, config, { stateFor, dispatchSubCall });
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
