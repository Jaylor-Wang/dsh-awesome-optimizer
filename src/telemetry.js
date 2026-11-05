import z from '@deepseek-ai/schemastery';
import { SOURCE as CONVERGENCE_SOURCE } from './convergence.js';
import { RECOVERY_SOURCE } from './failure-recovery.js';

export const TelemetryConfig = z.object({
  enabled: z.boolean().default(true),
  trackStreams: z.boolean().default(true),
  onTurnSummary: z.any()
});

function computeQuantile(sortedNumbers, p) {
  if (!sortedNumbers.length) return null;
  const idx = Math.max(0, Math.ceil(sortedNumbers.length * p) - 1);
  return Math.round(sortedNumbers[idx] * 100) / 100;
}

/**
 * Compare a candidate run summary against a baseline run summary.
 * Negative deltas on requests, failures, wallClockMs, and tokens indicate reductions.
 */
export function compareTurnSummaries(baseline, candidate) {
  const baseReq = baseline?.modelRequests ?? 0;
  const candReq = candidate?.modelRequests ?? 0;
  const baseTools = baseline?.toolCalls ?? 0;
  const candTools = candidate?.toolCalls ?? 0;
  const baseWall = baseline?.wallClockMs ?? 0;
  const candWall = candidate?.wallClockMs ?? 0;
  const baseIn = baseline?.usage?.inputTokens ?? 0;
  const candIn = candidate?.usage?.inputTokens ?? 0;
  const baseOut = baseline?.usage?.outputTokens ?? 0;
  const candOut = candidate?.usage?.outputTokens ?? 0;

  return {
    modelRequests: {
      baseline: baseReq,
      candidate: candReq,
      delta: candReq - baseReq
    },
    toolCalls: {
      baseline: baseTools,
      candidate: candTools,
      delta: candTools - baseTools
    },
    parallelismRatio: {
      baseline: baseline?.parallelismRatio ?? 0,
      candidate: candidate?.parallelismRatio ?? 0,
      delta: Math.round(((candidate?.parallelismRatio ?? 0) - (baseline?.parallelismRatio ?? 0)) * 100) / 100
    },
    failedToolCalls: {
      baseline: baseline?.failedToolCalls ?? 0,
      candidate: candidate?.failedToolCalls ?? 0,
      delta: (candidate?.failedToolCalls ?? 0) - (baseline?.failedToolCalls ?? 0)
    },
    wallClockMs: {
      baseline: baseWall,
      candidate: candWall,
      delta: Math.round((candWall - baseWall) * 100) / 100
    },
    inputTokens: {
      baseline: baseIn,
      candidate: candIn,
      delta: candIn - baseIn
    },
    outputTokens: {
      baseline: baseOut,
      candidate: candOut,
      delta: candOut - baseOut
    },
    prefixChanges: {
      baseline: baseline?.prefixChanges ?? 0,
      candidate: candidate?.prefixChanges ?? 0
    },
    bothCompleted: baseline?.turnOutcome === 'completed' && candidate?.turnOutcome === 'completed'
  };
}

/**
 * Non-invasive telemetry collector for turn/step round-trips, tool parallelism,
 * policy interceptions, and stream token/latency metrics.
 */
export class AgentTelemetryManager {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = TelemetryConfig(config);
    this.sessionStates = new WeakMap();
    this.activeSession = null;
  }

  #createTurnState(turn) {
    return {
      turn,
      startedAt: performance.now(),
      endedAt: null,
      steps: 0,
      currentStep: 0,
      stepToolCounts: new Map(),
      assistantMessages: 0,
      toolCalls: 0,
      ptcSubCalls: 0,
      failedToolCalls: 0,
      reminders: 0,
      recoveryNotices: 0,
      turnOutcome: null,
      streamAttempts: [],
      previousHistory: null,
      prefixChanges: 0
    };
  }

  stateFor(session, turn) {
    if (!session) return null;
    let state = this.sessionStates.get(session);
    const targetTurn = turn ?? state?.turn ?? 1;
    if (!state || state.turn !== targetTurn) {
      state = this.#createTurnState(targetTurn);
      this.sessionStates.set(session, state);
    }
    return state;
  }

  onSessionEvent(session, event) {
    this.activeSession = session;
    if (event.type === 'turn/start') {
      const state = this.#createTurnState(event.data.turn);
      this.sessionStates.set(session, state);
      return;
    }
    const state = this.stateFor(session, event.data?.turn);
    if (!state) return;

    if (event.type === 'step/start') {
      state.steps++;
      state.currentStep = event.data.step ?? state.steps;
      if (!state.stepToolCounts.has(state.currentStep)) {
        state.stepToolCounts.set(state.currentStep, 0);
      }
    } else if (event.type === 'assistant/message') {
      state.assistantMessages++;
    } else if (event.type === 'tool/call') {
      state.toolCalls++;
      const stepKey = state.currentStep || 1;
      state.stepToolCounts.set(stepKey, (state.stepToolCounts.get(stepKey) ?? 0) + 1);
    } else if (event.type === 'tool/ptc-dispatch-start') {
      state.ptcSubCalls++;
    } else if (event.type === 'tool/result') {
      if (event.data?.message?.isError || event.data?.isError) {
        state.failedToolCalls++;
      }
    } else if (event.type === 'user/message') {
      const kind = event.data?.source?.kind;
      if (kind === CONVERGENCE_SOURCE) state.reminders++;
      if (kind === RECOVERY_SOURCE) state.recoveryNotices++;
    } else if (event.type === 'turn/end') {
      state.endedAt = performance.now();
      state.turnOutcome = event.data?.reason?.kind ?? 'unknown';
      if (typeof this.config.onTurnSummary === 'function') {
        try {
          this.config.onTurnSummary(this.getSummary(session, state.turn), session);
        } catch {
          // Never allow a telemetry callback error to disrupt the agent loop.
        }
      }
    }
  }

  wrapStream(options, next) {
    const session = this.activeSession;
    const state = session ? this.sessionStates.get(session) : null;
    if (!state) return next();

    if (Array.isArray(options?.messages)) {
      const history = options.messages.map(message => JSON.stringify(message));
      if (state.previousHistory?.some((msg, idx) => history[idx] !== msg)) {
        state.prefixChanges++;
      }
      state.previousHistory = history;
    }

    const attempt = {
      started: performance.now(),
      elapsedMs: null,
      firstTokenMs: null,
      usage: null
    };
    state.streamAttempts.push(attempt);

    const stream = next();
    return (async function* () {
      try {
        for await (const chunk of stream) {
          const isToken = (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
            ? chunk.text !== ''
            : chunk.type === 'tool-call-delta' && (chunk.name !== undefined || chunk.argumentsDelta !== '');
          if (isToken && attempt.firstTokenMs === null) {
            attempt.firstTokenMs = performance.now() - attempt.started;
          }
          if (chunk.type === 'usage') {
            attempt.usage = chunk.usage;
          }
          yield chunk;
        }
      } finally {
        attempt.elapsedMs = performance.now() - attempt.started;
      }
    })();
  }

  getSummary(session, turn) {
    const targetSession = session ?? this.activeSession;
    const state = targetSession ? this.stateFor(targetSession, turn) : null;
    if (!state) {
      return {
        turn: turn ?? 0,
        steps: 0,
        modelRequests: 0,
        toolCalls: 0,
        ptcSubCalls: 0,
        toolBatches: 0,
        maxBatchSize: 0,
        parallelismRatio: 0,
        failedToolCalls: 0,
        reminders: 0,
        recoveryNotices: 0,
        prefixChanges: 0,
        wallClockMs: 0,
        modelStreamMs: 0,
        firstTokenMs: { n: 0, p50: null, p95: null },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        turnOutcome: null,
        runtimePolicy: null,
        fileMutationPolicy: null,
        failureRecovery: null,
        compositeTools: null
      };
    }

    const batchCounts = [...state.stepToolCounts.values()].filter(count => count > 0);
    const toolBatches = batchCounts.length;
    const maxBatchSize = batchCounts.length > 0 ? Math.max(...batchCounts) : 0;
    const parallelismRatio = toolBatches > 0
      ? Math.round((state.toolCalls / toolBatches) * 100) / 100
      : 0;

    const modelRequests = state.streamAttempts.length > 0
      ? state.streamAttempts.length
      : state.assistantMessages;

    const modelStreamMs = Math.round(
      state.streamAttempts.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0) * 100
    ) / 100;

    const firstTokens = state.streamAttempts
      .map(item => item.firstTokenMs)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const sumUsage = key => state.streamAttempts.reduce((sum, item) => sum + (item.usage?.[key] ?? 0), 0);
    const endMark = state.endedAt ?? performance.now();
    const wallClockMs = Math.round(Math.max(0, endMark - state.startedAt) * 100) / 100;

    return {
      turn: state.turn,
      steps: state.steps,
      modelRequests,
      toolCalls: state.toolCalls,
      ptcSubCalls: state.ptcSubCalls,
      toolBatches,
      maxBatchSize,
      parallelismRatio,
      failedToolCalls: state.failedToolCalls,
      reminders: state.reminders,
      recoveryNotices: state.recoveryNotices,
      prefixChanges: state.prefixChanges,
      wallClockMs,
      modelStreamMs,
      firstTokenMs: {
        n: firstTokens.length,
        p50: computeQuantile(firstTokens, 0.5),
        p95: computeQuantile(firstTokens, 0.95)
      },
      usage: {
        inputTokens: sumUsage('inputTokens'),
        outputTokens: sumUsage('outputTokens'),
        cacheReadTokens: sumUsage('cacheReadTokens'),
        cacheWriteTokens: sumUsage('cacheWriteTokens')
      },
      turnOutcome: state.turnOutcome,
      runtimePolicy: this.ctx?.get?.('runtimePolicy')?.getSummary(targetSession, state.turn) ?? null,
      fileMutationPolicy: this.ctx?.get?.('fileMutationPolicy')?.getSummary(targetSession, state.turn) ?? null,
      failureRecovery: this.ctx?.get?.('failureRecovery')?.getStats(targetSession) ?? null,
      compositeTools: this.ctx?.get?.('compositeTools')?.getStats(targetSession) ?? null
    };
  }
}

export function applyTelemetry(ctx, rawConfig = {}) {
  const config = TelemetryConfig(rawConfig);
  if (!config.enabled) return null;

  const manager = new AgentTelemetryManager(ctx, config);

  ctx.on('session/event', (session, event) => {
    manager.onSessionEvent(session, event);
  });

  if (config.trackStreams) {
    ctx.on('llm/stream', (options, next) => manager.wrapStream(options, next));
  }

  return manager;
}

export const name = 'agent-optimizer-telemetry';
export const Config = TelemetryConfig;
export function apply(ctx, config = {}) {
  const manager = applyTelemetry(ctx, config);
  if (manager) ctx.provide('agentTelemetry', manager);
}
export default { name, Config, apply };
