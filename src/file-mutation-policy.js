import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { normalizePath } from './runtime-policy.js';

export const MUTATION_SOURCE = 'optimizer-file-mutation-policy';

export const FileMutationPolicyConfig = z.object({
  mode: z.union(['off', 'observe', 'enforce']).default('observe'),
  minLargeWriteBytes: z.number().step(1).min(1).default(8192),
  reminderLimit: z.number().step(1).min(1).default(1),
  allowFullReplacement: z.any()
});

/**
 * Check safely whether a file path exists via ctx.fs backend if available,
 * falling back to local filesystem check.
 */
export async function fileExists(filePath, cwd = '', fsService, signal) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (fsService && typeof fsService.resolve === 'function') {
    try {
      const target = await fsService.resolve(filePath, { cwd, signal });
      if (typeof fsService.stat === 'function') {
        const info = await fsService.stat(target, signal);
        return info !== undefined;
      }
      return target !== undefined;
    } catch {
      return false;
    }
  }
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * Manager tracking file reads, writes, and enforcing edit vs write constraints.
 */
export class FileMutationPolicyManager {
  constructor(config = {}, fsService, workingDirectory) {
    this.config = FileMutationPolicyConfig(config);
    this.fsService = fsService;
    this.workingDirectory = workingDirectory;
    this.sessionStates = new WeakMap();
  }

  #createTurnState(turn, cwd = '') {
    return {
      turn,
      cwd,
      observedFiles: new Set(),
      knownExistingFiles: new Set(),
      createdFiles: new Set(),
      pendingCreates: new Map(),
      largeWriteViolations: 0,
      largeWritesBlocked: 0,
      fullReplacementsAllowed: 0,
      editsCount: 0,
      records: []
    };
  }

  stateFor(session, turn) {
    if (!session) return null;
    let state = this.sessionStates.get(session);
    const targetTurn = turn ?? state?.turn ?? 1;
    if (!state || state.turn !== targetTurn) {
      state = this.#createTurnState(targetTurn, state?.cwd ?? '');
      this.sessionStates.set(session, state);
    }
    return state;
  }

  onTurnStart(session, turn) {
    const existing = this.sessionStates.get(session);
    this.sessionStates.set(session, this.#createTurnState(turn, existing?.cwd ?? ''));
  }

  onTurnEnd(session) {
    const state = this.sessionStates.get(session);
    state?.pendingCreates.clear();
  }

  onCwdChange(session, newCwd) {
    const state = this.sessionStates.get(session);
    if (!state) return;
    state.cwd = newCwd;
    state.observedFiles.clear();
    state.knownExistingFiles.clear();
    state.createdFiles.clear();
    state.pendingCreates.clear();
  }

  async evaluateToolExecution(session, exec, toolsService, fsService = this.fsService) {
    if (this.config.mode === 'off' || !session || !exec) {
      return { allowed: true, reason: 'policy-off' };
    }
    const state = this.stateFor(session);
    if (!state) return { allowed: true, reason: 'no-state' };

    if (exec.parent !== undefined) {
      return { allowed: true, reason: 'nested-ptc-call' };
    }

    if (exec.name === 'retry_failed_write') {
      return { allowed: true, reason: 'recovery-tool' };
    }

    if (exec.name !== 'write') {
      return { allowed: true, reason: 'not-write' };
    }

    const args = exec.arguments ?? {};
    const targetPath = typeof args.file_path === 'string' ? args.file_path : '';
    const normPath = normalizePath(targetPath, state.cwd);
    const content = typeof args.content === 'string' ? args.content : '';
    const byteLength = Buffer.byteLength(content, 'utf8');

    if (state.createdFiles.has(normPath)) {
      return { allowed: true, reason: 'created-in-this-turn' };
    }

    const createPending = [...state.pendingCreates.values()].includes(normPath);
    const existsInBackend = await fileExists(targetPath, state.cwd, fsService, exec.signal);
    const knownExisting = state.knownExistingFiles.has(normPath) || existsInBackend;
    if (!knownExisting && !createPending) {
      state.pendingCreates.set(exec.callId, normPath);
      return { allowed: true, reason: 'target-does-not-exist' };
    }

    if (byteLength < this.config.minLargeWriteBytes) {
      return { allowed: true, reason: 'below-size-threshold' };
    }

    if (toolsService && toolsService.get && toolsService.get('edit', exec.agent) === undefined) {
      return { allowed: true, reason: 'no-edit-available' };
    }

    let hostApprovedReplacement = false;
    try {
      hostApprovedReplacement = typeof this.config.allowFullReplacement === 'function'
        && this.config.allowFullReplacement(exec, normPath) === true;
    } catch {
      // Never convert a host callback exception into a loop crash.
    }
    if (hostApprovedReplacement) {
      state.fullReplacementsAllowed++;
      return { allowed: true, reason: 'host-approved-replacement' };
    }

    state.largeWriteViolations++;
    const violation = {
      callId: exec.callId,
      targetPath: normPath,
      byteLength,
      code: 'LARGE_WRITE_EXISTING_FILE',
      reason: 'target is known existing and the call appears to replace the whole file',
      nextAction: 'use edit with an exact unique match, or use the host-approved full-replacement path',
      retryable: false
    };
    state.records.push(violation);

    if (this.config.mode === 'enforce') {
      state.largeWritesBlocked++;
      return {
        allowed: false,
        ...violation
      };
    }

    return {
      allowed: true,
      ...violation
    };
  }

  recordResult(session, exec, result) {
    if (!session || !exec) return;
    const state = this.stateFor(session);
    if (!state) return;

    const args = exec.arguments ?? {};
    if (exec.name === 'write') {
      const pendingPath = state.pendingCreates.get(exec.callId);
      state.pendingCreates.delete(exec.callId);
      if (result && !result.isError && pendingPath) state.createdFiles.add(pendingPath);
    } else if (result?.isError) {
      return;
    } else if (exec.name === 'edit') {
      state.editsCount++;
      if (typeof args.file_path === 'string') {
        const filePath = normalizePath(args.file_path, state.cwd);
        state.observedFiles.add(filePath);
        state.knownExistingFiles.add(filePath);
      }
    } else if (['read', 'read_image'].includes(exec.name)) {
      if (typeof args.file_path === 'string') {
        const filePath = normalizePath(args.file_path, state.cwd);
        state.observedFiles.add(filePath);
        state.knownExistingFiles.add(filePath);
      }
    } else if (exec.name === 'read_batch' && exec.parent === undefined && Array.isArray(args.files)) {
      // Leaf read sub-calls already record successful reads; only use batch fallback if called outside pipeline.
    } else if (['grep', 'glob'].includes(exec.name)) {
      if (typeof args.path === 'string') {
        state.observedFiles.add(normalizePath(args.path, state.cwd));
      }
    }
  }

  getSummary(session, turn) {
    const state = this.stateFor(session, turn);
    if (!state) {
      return {
        largeWriteViolations: 0,
        largeWritesBlocked: 0,
        fullReplacementsAllowed: 0,
        editsCount: 0,
        observedFiles: 0,
        createdFiles: 0
      };
    }
    return {
      largeWriteViolations: state.largeWriteViolations,
      largeWritesBlocked: state.largeWritesBlocked,
      fullReplacementsAllowed: state.fullReplacementsAllowed,
      editsCount: state.editsCount,
      observedFiles: state.observedFiles.size,
      createdFiles: state.createdFiles.size
    };
  }
}

/**
 * Apply file mutation policy to Cordis context.
 */
export function applyFileMutationPolicy(ctx, rawConfig = {}) {
  const config = FileMutationPolicyConfig(rawConfig);
  if (config.mode === 'off') return null;

  const fsService = ctx.get ? ctx.get('fs') : undefined;
  const workingDirectory = ctx.get ? ctx.get('workingDirectory') : undefined;
  const manager = new FileMutationPolicyManager(config, fsService, workingDirectory);

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      manager.onTurnStart(session, event.data.turn);
    } else if (event.type === 'turn/end') {
      manager.onTurnEnd(session);
    } else if (event.type === 'working-directory/change') {
      manager.onCwdChange(session, event.data.cwd);
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    const effectiveFs = (ctx.get ? ctx.get('fs') : undefined) ?? manager.fsService;
    const decision = await manager.evaluateToolExecution(exec.agent.session, exec, ctx.tools, effectiveFs);
    if (!decision.allowed) {
      return {
        kind: 'deny',
        reason: JSON.stringify({
          code: decision.code,
          reason: decision.reason,
          nextAction: decision.nextAction,
          retryable: decision.retryable
        })
      };
    }
    return next();
  });

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    manager.recordResult(exec.agent.session, exec, result);
  });

  return manager;
}

export const name = 'agent-optimizer-file-mutation-policy';
export const Config = FileMutationPolicyConfig;
export function apply(ctx, config = {}) {
  const manager = applyFileMutationPolicy(ctx, config);
  if (manager) ctx.provide('fileMutationPolicy', manager);
}
export default { name, Config, apply };
