import { HarnessError } from '@deepseek-ai/dsh-llm';
import { normalizePath } from './runtime-policy.js';
import { buildEditFailureHint } from './edit-recovery.js';
import { getFsService, getWorkingDirectory, readFilePreflight } from './fs-preflight.js';

export const EDIT_BATCH_TOOL = 'edit_batch';

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

export function simulateEditsOnContent(initialContent, items, normalizeLineEndings = true) {
  const normalize = text => (normalizeLineEndings ? text.replaceAll('\r\n', '\n') : text);
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
      const hint = buildEditFailureHint(simulated, oldString, { filePath: item.file_path });
      return {
        ok: false,
        failedIndex: index,
        reason: `Pre-flight failed at edit #${index + 1} (${item.file_path}): old_string not found (no changes written to this file).\n\n${hint}`
      };
    }
    if (!item.replace_all && matches > 1) {
      const hint = buildEditFailureHint(simulated, oldString, { filePath: item.file_path });
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

async function resolveCachedTarget(filePath, { fsService, cwd, signal, cache }) {
  if (cache.has(filePath)) return cache.get(filePath);
  if (typeof fsService?.resolve !== 'function') {
    const entry = { ok: false, reason: 'Pre-flight could not verify the target identity through the native filesystem service.' };
    cache.set(filePath, entry);
    return entry;
  }
  try {
    const target = await fsService.resolve(filePath, { cwd, signal });
    signal.throwIfAborted();
    if (typeof target?.targetKey === 'string' && target.targetKey) {
      const entry = { ok: true, target };
      cache.set(filePath, entry);
      return entry;
    }
    const entry = { ok: false, reason: 'Pre-flight could not verify the target identity through the native filesystem service.' };
    cache.set(filePath, entry);
    return entry;
  } catch (error) {
    signal.throwIfAborted();
    if (error?.code === 'ENOENT' || error?.code === 'FS_NOT_FOUND') {
      const entry = { ok: false, missing: true, reason: 'Pre-flight failed: target file does not exist.' };
      cache.set(filePath, entry);
      return entry;
    }
    const detail = error instanceof Error && error.message
      ? error.message
      : (typeof error?.code === 'string' ? error.code : 'access denied');
    const codeTag = typeof error?.code === 'string' && !detail.includes(error.code) ? ` (${error.code})` : '';
    const entry = { ok: false, reason: `Pre-flight failed to resolve target: ${detail}${codeTag}.` };
    cache.set(filePath, entry);
    return entry;
  }
}

async function validateAndGroupEdits(edits, { isAtomic, fsService, cwd, signal }) {
  const editsByPath = new Map();
  const invalidEntries = new Map();
  const pathKeys = new Map();
  const targetsByPath = new Map();
  const canOpportunisticallyResolve = !isAtomic && edits.length > 1 && typeof fsService?.resolve === 'function';

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
      signal.throwIfAborted();
      const resolved = await resolveCachedTarget(item.file_path, {
        fsService, cwd, signal, cache: targetsByPath
      });
      if (!resolved.ok) {
        invalidEntries.set(index, resolved.reason);
        continue;
      }
      target = resolved.target;
      pathKey = target.targetKey;
    } else if (canOpportunisticallyResolve && typeof item.sandbox_permissions !== 'string') {
      // Group aliased/symlinked paths onto the same physical identity when the host fs resolves them.
      signal.throwIfAborted();
      const resolved = await resolveCachedTarget(item.file_path, {
        fsService, cwd, signal, cache: targetsByPath
      });
      if (resolved.ok) {
        target = resolved.target;
        pathKey = target.targetKey;
      }
    }

    pathKeys.set(index, pathKey);
    if (!editsByPath.has(pathKey)) editsByPath.set(pathKey, []);
    editsByPath.get(pathKey).push({ index, item, target });
  }

  return { editsByPath, invalidEntries, pathKeys };
}

async function runEditPreflight(editsByPath, { isAtomic, fsService, cwd, signal, maxPreflightBytes }) {
  const preflightBlockedPaths = new Map();

  for (const [pathKey, group] of editsByPath.entries()) {
    const shouldPreflight = isAtomic || group.length > 1;
    if (!shouldPreflight) continue;
    if (group.some(({ item }) => typeof item.sandbox_permissions === 'string')) continue;

    // Resolve aliases to one simulation; strict mode requires every distinct path to be readable.
    const inputs = isAtomic
      ? new Map(group.map(entry => [entry.item.file_path, entry.target]))
      : new Map([[group[0].item.file_path, group[0].target]]);

    let content;
    for (const [filePath, target] of inputs) {
      signal.throwIfAborted();
      const probe = await readFilePreflight({
        filePath,
        cwd,
        fsService,
        target,
        signal,
        maxBytes: maxPreflightBytes,
        allowReadFile: true
      });
      signal.throwIfAborted();

      if (probe.reason === 'missing') {
        preflightBlockedPaths.set(pathKey, `Pre-flight failed (${filePath}): target file does not exist (no changes written).`);
        break;
      }
      if (probe.reason === 'oversized') {
        if (isAtomic) {
          preflightBlockedPaths.set(pathKey, `Pre-flight skipped (${filePath}): file exceeds maxPreflightBytes (${maxPreflightBytes} bytes; no edits dispatched).`);
        }
        break;
      }
      if (!probe.ok || (content !== undefined && probe.content !== content)) {
        if (isAtomic) {
          preflightBlockedPaths.set(pathKey, `Pre-flight could not verify a readable, consistent snapshot for ${filePath} (no edits dispatched).`);
        }
        break;
      }
      content = probe.content;
    }

    if (content !== undefined && !preflightBlockedPaths.has(pathKey)) {
      const sim = simulateEditsOnContent(content, group, true);
      if (!sim.ok) preflightBlockedPaths.set(pathKey, sim.reason);
    }
  }

  return preflightBlockedPaths;
}

export function registerEditBatchTool(ctx, config, { stateFor, dispatchSubCall }) {
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

      const fsService = getFsService(ctx);
      const cwd = getWorkingDirectory(ctx, session);

      const { editsByPath, invalidEntries, pathKeys } = await validateAndGroupEdits(edits, {
        isAtomic,
        fsService,
        cwd,
        signal: exec.signal
      });
      const preflightBlockedPaths = await runEditPreflight(editsByPath, {
        isAtomic,
        fsService,
        cwd,
        signal: exec.signal,
        maxPreflightBytes: config.maxPreflightBytes
      });

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
