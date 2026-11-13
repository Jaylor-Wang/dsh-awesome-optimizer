import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { normalizePath } from './runtime-policy.js';

export const READ_BATCH_TOOL = 'read_batch';
export const EDIT_BATCH_TOOL = 'edit_batch';

export const CompositeToolsConfig = z.object({
  enabled: z.boolean().default(true),
  readBatch: z.boolean().default(true),
  editBatch: z.boolean().default(true),
  maxBatchFiles: z.number().step(1).min(1).max(25).default(10),
  maxBatchEdits: z.number().step(1).min(1).max(25).default(10),
  defaultLimitPerFile: z.number().step(1).min(1).max(2000).default(400),
  maxLineChars: z.number().step(1).min(100).max(50000).default(2000),
  maxTotalBytes: z.number().step(1).min(512).max(1024 * 1024).default(65536),
  atomicEdits: z.boolean().default(false)
});

export function truncateLongLines(text, maxLineChars = 2000) {
  if (typeof text !== 'string' || !maxLineChars || maxLineChars <= 0) return text;
  const lines = text.split('\n');
  let modified = false;
  const out = lines.map(line => {
    if (line.length <= maxLineChars) return line;
    modified = true;
    return `${line.slice(0, maxLineChars)}... [line truncated: +${line.length - maxLineChars} chars]`;
  });
  return modified ? out.join('\n') : text;
}

function sliceUtf8ToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, end);
}

export function renderReadBatchResults(entries, { maxLineChars = 2000, maxTotalBytes = 65536 } = {}) {
  const blocks = [];
  let usedBytes = 0;
  let truncatedCount = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const header = `=== [${entry.isError ? 'ERROR' : 'FILE'}] ${entry.filePath} ===\n`;
    const body = entry.isError ? entry.text : truncateLongLines(entry.text, maxLineChars);
    const fullBlock = `${header}${body}`;
    const separatorBytes = i > 0 ? 2 : 0; // '\n\n'
    const fullBytes = Buffer.byteLength(fullBlock, 'utf8');

    if (usedBytes + separatorBytes + fullBytes <= maxTotalBytes) {
      blocks.push(fullBlock);
      usedBytes += separatorBytes + fullBytes;
      continue;
    }

    if (blocks.length === 0) {
      const suffix = `\n[Truncated at ${maxTotalBytes} bytes limit; read with narrower offset/limit]`;
      const allowedBodyBytes = Math.max(64, maxTotalBytes - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(suffix, 'utf8'));
      const clipped = sliceUtf8ToBytes(body, allowedBodyBytes);
      const firstBlock = `${header}${clipped}${suffix}`;
      blocks.push(firstBlock);
      usedBytes += Buffer.byteLength(firstBlock, 'utf8');
      truncatedCount++;
    } else {
      const placeholder = `=== [TRUNCATED] ${entry.filePath} ===\n[Omitted to stay within read_batch maxTotalBytes (${maxTotalBytes} bytes); read separately with narrower offset/limit.]`;
      blocks.push(placeholder);
      usedBytes += separatorBytes + Buffer.byteLength(placeholder, 'utf8');
      truncatedCount++;
    }
  }

  const rendered = blocks.join('\n\n');
  if (truncatedCount > 0) {
    return `${rendered}\n\n[read_batch budget: truncated/omitted ${truncatedCount} of ${entries.length} entries to stay within maxTotalBytes=${maxTotalBytes}]`;
  }
  return rendered;
}

async function readFileForPreflight(filePath, cwd, fsService, signal) {
  if (fsService) {
    if (typeof fsService.readFile === 'function') {
      try {
        const content = await fsService.readFile(filePath, { cwd, signal, encoding: 'utf8' });
        return typeof content === 'string' ? { ok: true, content } : null;
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: false, missing: true };
        return null;
      }
    }
    if (typeof fsService.readText === 'function') {
      try {
        const content = await fsService.readText(filePath, { cwd, signal });
        return typeof content === 'string' ? { ok: true, content } : null;
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: false, missing: true };
        return null;
      }
    }
  }
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    const content = await fs.readFile(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    // If a custom fsService is mounted without readFile/readText (e.g. virtual/remote FS),
    // do not assume local ENOENT means missing — fall back to native edit pipeline.
    if (!fsService && err?.code === 'ENOENT') return { ok: false, missing: true };
    return null;
  }
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
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string not found (no changes written to this file).`
      };
    }
    if (!item.replace_all && matches > 1) {
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string matched ${matches} locations; set replace_all=true or provide more context.`
      };
    }
    simulated = item.replace_all
      ? simulated.split(item.old_string).join(item.new_string)
      : simulated.replace(item.old_string, item.new_string);
  }
  return { ok: true };
}

/**
 * Register safe composite tools that collapse predictable multi-step operations
 * (read_batch for reading, edit_batch for literal revisions) into a single model round-trip
 * while routing every sub-call through ToolExecutionPipeline so all sandbox policies,
 * permissions, and file-observation hooks remain enforced.
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
      state = {
        batchesExecuted: 0,
        filesRequested: 0,
        filesSucceeded: 0,
        filesFailed: 0,
        editBatchesExecuted: 0,
        editsRequested: 0,
        editsSucceeded: 0,
        editsFailed: 0
      };
      statsBySession.set(session, state);
    }
    return state;
  };

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      statsBySession.set(session, {
        batchesExecuted: 0,
        filesRequested: 0,
        filesSucceeded: 0,
        filesFailed: 0,
        editBatchesExecuted: 0,
        editsRequested: 0,
        editsSucceeded: 0,
        editsFailed: 0
      });
    }
  });

  if (config.readBatch) {
    ctx.tools.register({
      name: READ_BATCH_TOOL,
      description: [
        `Read multiple UTF-8 text files (up to ${config.maxBatchFiles}) in a single tool call to avoid sequential single-file round trips.`,
        'Each entry dispatches through the native read tool pipeline with full sandbox and policy checks.',
        'Can be called alongside glob or grep in the same turn.'
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['files'],
        properties: {
          files: {
            type: 'array',
            minItems: 1,
            maxItems: config.maxBatchFiles,
            description: `List of file read specifications (1 to ${config.maxBatchFiles} files).`,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file_path'],
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Path to read, resolved by the filesystem backend.'
                },
                offset: {
                  type: 'number',
                  description: '1-based first line to return. Defaults to 1.'
                },
                limit: {
                  type: 'number',
                  description: `Maximum number of lines to return. Defaults to ${config.defaultLimitPerFile}.`
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
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const files = Array.isArray(args?.files) ? args.files : [];
        if (files.length === 0) {
          throw new HarnessError('read_batch requires at least one file entry in "files".', 'INVALID_READ_BATCH_ARGS');
        }
        if (files.length > config.maxBatchFiles) {
          throw new HarnessError(
            `read_batch received ${files.length} files, exceeding maxBatchFiles (${config.maxBatchFiles}).`,
            'READ_BATCH_LIMIT_EXCEEDED'
          );
        }

        const session = exec.agent?.session;
        const state = stateFor(session);
        if (state) {
          state.batchesExecuted++;
          state.filesRequested += files.length;
        }

        const subResults = await Promise.all(files.map(async (item, index) => {
          exec.signal.throwIfAborted();
          if (!item || typeof item.file_path !== 'string' || !item.file_path.trim()) {
            if (state) state.filesFailed++;
            return {
              filePath: String(item?.file_path ?? `<invalid-${index}>`),
              isError: true,
              text: 'Invalid file_path: must be a non-empty string.'
            };
          }
          const readArgs = {
            file_path: item.file_path,
            ...(typeof item.offset === 'number' ? { offset: item.offset } : {}),
            limit: typeof item.limit === 'number' ? item.limit : config.defaultLimitPerFile
          };
          const subCallId = `${exec.callId}:read-batch-${index}`;
          const log = {
            rootCallId: exec.rootCallId,
            parentCallId: exec.callId,
            subCallId,
            name: 'read',
            arguments: readArgs
          };
          if (session?.append) {
            session.append('tool/ptc-dispatch-start', log);
          }
          const prepared = await pipeline.prepare({
            callId: subCallId,
            rootCallId: exec.rootCallId,
            parent: exec.token,
            name: 'read',
            arguments: readArgs,
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
          if (result.isError) {
            if (state) state.filesFailed++;
            const msg = result.error?.message
              ?? result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
              ?? 'Read failed';
            return {
              filePath: item.file_path,
              isError: true,
              text: `[ERROR] ${msg}`
            };
          }
          if (state) state.filesSucceeded++;
          const text = (result.content ?? [])
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
          return {
            filePath: item.file_path,
            isError: false,
            text
          };
        }));

        const allFailed = subResults.every(entry => entry.isError);
        const rendered = allFailed
          ? subResults
              .map(entry => `=== [ERROR] ${entry.filePath} ===\n${entry.text}`)
              .join('\n\n')
          : renderReadBatchResults(subResults, {
              maxLineChars: config.maxLineChars,
              maxTotalBytes: config.maxTotalBytes
            });

        if (allFailed) {
          throw new HarnessError(rendered, 'READ_BATCH_ALL_FAILED');
        }
        return rendered;
      }
    }, { when: ({ agent }) => ctx.tools.get('read', agent) !== undefined });
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

        // Group valid edits by normalized target path for same-file / atomic pre-flight checks
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
          // Pre-flight simulate whenever atomic=true or multiple sequential edits target the same file
          const shouldPreflight = isAtomic || group.length > 1;
          if (!shouldPreflight) continue;
          // If any item requests sandbox escalation, let the pipeline handle permissions directly
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

          const subCallId = `${exec.callId}:edit-batch-${index}`;
          const log = {
            rootCallId: exec.rootCallId,
            parentCallId: exec.callId,
            subCallId,
            name: 'edit',
            arguments: editArgs
          };
          if (session?.append) {
            session.append('tool/ptc-dispatch-start', log);
          }

          const prepared = await pipeline.prepare({
            callId: subCallId,
            rootCallId: exec.rootCallId,
            parent: exec.token,
            name: 'edit',
            arguments: editArgs,
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
      return s
        ? { ...s }
        : {
            batchesExecuted: 0,
            filesRequested: 0,
            filesSucceeded: 0,
            filesFailed: 0,
            editBatchesExecuted: 0,
            editsRequested: 0,
            editsSucceeded: 0,
            editsFailed: 0
          };
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
