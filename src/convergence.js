import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'agent-optimizer-convergence';
export const inject = ['systemPrompt', 'tools'];
export const SOURCE = 'optimizer-convergence';

const SERIAL_READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'find_and_read', 'skill']);

export function buildGuidance({ hasFindAndRead = true, hasEditBatch = true } = {}) {
  return [
    "Work toward the user's completion criteria with as few model round trips as practical.",
    hasFindAndRead
      ? 'For searches across multiple source files that need matching code and surrounding context, use find_and_read. For known files, batch independent read calls in parallel. Keep dependent inspections and retries sequential.'
      : 'For known files, batch independent read and search calls in parallel. Keep dependent inspections and retries sequential.',
    'Chain dependent shell steps with &&. Run long tests or builds separately when they need their own timeouts or logs.',
    'Before emitting a large payload or calculation, produce deliverables or reusable scripts to disk using native write and execute by file path. NEVER embed complete files, calculations, or large scripts in shell arguments (node -e, python -c, pwsh -Command).',
    hasEditBatch
      ? 'For localized revisions on existing files, reuse context already in the conversation and prefer native edit (or edit_batch for multi-file/multi-location revisions) with an unambiguous match over rewriting the entire file.'
      : 'For localized revisions on existing files, reuse context already in the conversation and prefer native edit with an unambiguous match over rewriting the entire file.',
    'After receiving tool results, make the next complete useful decision without repeating equivalent searches or checks unless new evidence justifies them.',
    'This efficiency guidance NEVER overrides the user, correctness, permission checks, required verification, or cancellation.'
  ].join('\n');
}

export const GUIDANCE = buildGuidance();

export const REMINDER = 'Batch remaining actions; conclude only if criteria are met; NEVER omit verification.';

export const ConvergenceConfig = z.object({
  enabled: z.boolean().default(true),
  mode: z.union(['adaptive', 'periodic']).default('adaptive'),
  injectGuidance: z.boolean().default(true),
  stepInterval: z.number().step(1).min(1).max(10000).default(8),
  cooldownSteps: z.number().step(1).min(1).max(10000).default(6),
  serialReadThreshold: z.number().step(1).min(2).max(100).default(4),
  longTailStepThreshold: z.number().step(1).min(2).max(10000).default(12),
  stallStepsThreshold: z.number().step(1).min(2).max(1000).default(6),
  maxRemindersPerTurn: z.number().step(1).min(1).max(100).default(4),
  softStepBudget: z.number().step(1).min(1).max(10000)
});

function hasTool(ctx, toolName, agent, toolSet) {
  try {
    if (!ctx?.tools?.get) return false;
    if (toolSet !== undefined) {
      return ctx.tools.get(toolName, agent, toolSet) !== undefined;
    }
    if (ctx.tools.get(toolName, agent) === undefined) return false;
    if (toolName === 'find_and_read') {
      return ctx.tools.get('grep', agent) !== undefined && ctx.tools.get('read', agent) !== undefined;
    }
    if (toolName === 'edit_batch') {
      return ctx.tools.get('edit', agent) !== undefined;
    }
    return true;
  } catch {
    return false;
  }
}

function createTurnState(turn, startSeq) {
  return {
    turn,
    steps: 0,
    currentStep: 0,
    reminded: false,
    remindersSent: 0,
    reminderCharsAdded: 0,
    lastReminderStep: 0,
    lastSignal: null,
    signals: {
      'serial-exploration': 0,
      'long-tail-stall': 0,
      periodic: 0
    },
    startSeq,
    stepFinalized: true,
    stepToolCount: 0,
    stepAllSerialRead: false,
    stepHadProgress: false,
    stepConcluded: false,
    stepHasError: false,
    consecutiveSerialReads: 0,
    stepsWithoutProgress: 0,
    recentBatchSizes: []
  };
}

function finalizeStepIfNeeded(state, maxRecentWindow) {
  if (state.stepFinalized || state.steps === 0) return;
  state.stepFinalized = true;
  if (state.stepToolCount === 0) return;

  if (state.stepToolCount === 1 && state.stepAllSerialRead) {
    if (!state.stepHasError) {
      state.consecutiveSerialReads++;
    }
  } else {
    state.consecutiveSerialReads = 0;
  }

  if (state.stepHadProgress) {
    state.stepsWithoutProgress = 0;
  } else {
    state.stepsWithoutProgress++;
  }

  state.recentBatchSizes.push(state.stepToolCount);
  const maxKeep = Math.max(maxRecentWindow, 6);
  if (state.recentBatchSizes.length > maxKeep) {
    state.recentBatchSizes.splice(0, state.recentBatchSizes.length - maxKeep);
  }
}

function onStepStart(state, step, maxRecentWindow) {
  finalizeStepIfNeeded(state, maxRecentWindow);
  state.steps++;
  state.currentStep = step ?? state.steps;
  state.stepFinalized = false;
  state.stepToolCount = 0;
  state.stepAllSerialRead = true;
  state.stepHadProgress = false;
  state.stepConcluded = false;
  state.stepHasError = false;
}

function recordToolResult(state, toolName, isError, concludesTurn) {
  state.stepToolCount++;
  if (isError) {
    state.stepHasError = true;
  }
  if (concludesTurn === true) {
    state.stepConcluded = true;
  }
  if (!SERIAL_READ_TOOLS.has(toolName)) {
    state.stepAllSerialRead = false;
  }
  if (toolName && !READ_ONLY_TOOLS.has(toolName) && !isError) {
    state.stepHadProgress = true;
  }
}

function onReminderCommitted(state, event) {
  state.reminded = true;
  state.remindersSent++;
  state.lastReminderStep = state.currentStep || state.steps;
  const text = Array.isArray(event.data?.content)
    ? event.data.content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
    : '';
  state.reminderCharsAdded += text.length || REMINDER.length;
  const signal = event.data?.source?.signal;
  if (signal && Object.prototype.hasOwnProperty.call(state.signals, signal)) {
    state.lastSignal = signal;
    state.signals[signal]++;
  } else {
    state.lastSignal = 'periodic';
    state.signals.periodic++;
  }
}

function isHealthyHighParallel(state, stallStepsThreshold) {
  const minSamples = Math.min(stallStepsThreshold, 3);
  const recent = state.recentBatchSizes.slice(-stallStepsThreshold);
  if (recent.length < minSamples) return false;
  const avg = recent.reduce((sum, n) => sum + n, 0) / recent.length;
  return avg >= 2;
}

function evaluateReminder(state, currentStep, config, ctx, agent, toolSet) {
  if (config.mode === 'periodic') {
    const interval = config.stepInterval ?? 8;
    const nextDueStep = state.lastReminderStep > 0 ? state.lastReminderStep + interval : interval;
    if (currentStep < nextDueStep) return null;
    return {
      signal: 'periodic',
      text: REMINDER,
      summary: 'Batch remaining actions; conclude only if criteria are met.'
    };
  }

  const highParallel = isHealthyHighParallel(state, config.stallStepsThreshold);
  const effectiveCooldown = highParallel ? config.cooldownSteps * 2 : config.cooldownSteps;
  if (state.lastReminderStep > 0 && currentStep < state.lastReminderStep + effectiveCooldown) {
    return null;
  }

  if (state.consecutiveSerialReads >= config.serialReadThreshold) {
    const hasFindAndRead = hasTool(ctx, 'find_and_read', agent, toolSet);
    return {
      signal: 'serial-exploration',
      text: hasFindAndRead
        ? `[Step ${currentStep}: ${state.consecutiveSerialReads} consecutive single-tool reads] Batch independent reads in parallel or use find_and_read; conclude only if criteria and verification are met.`
        : `[Step ${currentStep}: ${state.consecutiveSerialReads} consecutive single-tool reads] Batch independent read/search calls in parallel; conclude only if criteria and verification are met.`,
      summary: 'Batch independent reads instead of serial single-tool exploration.'
    };
  }

  const effectiveLongTailStep = highParallel ? config.longTailStepThreshold * 2 : config.longTailStepThreshold;
  const effectiveStallSteps = highParallel ? config.stallStepsThreshold * 2 : config.stallStepsThreshold;
  if (currentStep >= effectiveLongTailStep && state.stepsWithoutProgress >= effectiveStallSteps) {
    return {
      signal: 'long-tail-stall',
      text: `[Step ${currentStep}: ${state.stepsWithoutProgress} steps without edits or verification] Synthesize findings, batch remaining changes or checks, and conclude only if criteria and verification are met.`,
      summary: 'Synthesize findings and converge without omitting verification.'
    };
  }

  return null;
}

/**
 * Add lightweight convergence guidance and signal-driven soft acceleration notices
 * without taking over the official loop's control flow or termination semantics.
 */
export function applyConvergence(ctx, raw = {}) {
  const effectiveInterval = (raw.softStepBudget !== undefined && (raw.stepInterval === undefined || raw.stepInterval === 8))
    ? raw.softStepBudget
    : (raw.stepInterval ?? raw.softStepBudget ?? 8);
  const config = ConvergenceConfig({
    ...raw,
    stepInterval: effectiveInterval
  });
  if (!config.enabled) return null;

  const states = new WeakMap();
  const stateFor = (session, turn) => {
    if (!session) return null;
    let state = states.get(session);
    if (!state || state.turn !== turn) {
      state = createTurnState(turn);
      if (typeof session.snapshotEvents === 'function') {
        let inTargetTurn = false;
        const callNames = new Map();
        for (const event of session.snapshotEvents()) {
          if (event.type === 'turn/start') {
            if (event.data?.turn === turn) {
              inTargetTurn = true;
              state.startSeq = event.seq;
            } else if (inTargetTurn) {
              inTargetTurn = false;
            }
            continue;
          }
          if (!inTargetTurn) continue;
          if (event.type === 'turn/end' && event.data?.turn === turn) {
            finalizeStepIfNeeded(state, config.stallStepsThreshold);
            inTargetTurn = false;
            continue;
          }
          if (event.type === 'step/start' && event.data?.turn === turn) {
            onStepStart(state, event.data.step, config.stallStepsThreshold);
          } else if (event.type === 'tool/call' && event.data?.turn === turn && event.data?.callId) {
            callNames.set(event.data.callId, event.data.name);
          } else if (event.type === 'tool/result' && event.data?.turn === turn) {
            const callId = event.data?.message?.callId;
            const toolName = (callId ? callNames.get(callId) : undefined) ?? event.data?.name;
            const isError = Boolean(event.data?.message?.isError || event.data?.isError || event.data?.error);
            recordToolResult(state, toolName, isError, event.data?.concludesTurn === true);
          } else if (event.type === 'step/end' && event.data?.turn === turn) {
            finalizeStepIfNeeded(state, config.stallStepsThreshold);
          } else if (event.type === 'user/message' && event.data?.source?.kind === SOURCE) {
            onReminderCommitted(state, event);
          }
        }
      }
      states.set(session, state);
    }
    return state;
  };

  if (config.injectGuidance && ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: 'optimizer:convergence',
      order: 650,
      text: (context) => buildGuidance({
        hasFindAndRead: hasTool(ctx, 'find_and_read', context?.agent),
        hasEditBatch: hasTool(ctx, 'edit_batch', context?.agent)
      }),
      interpolate: false
    });
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, createTurnState(event.data.turn, event.seq));
      return;
    }
    const state = states.get(session);
    if (!state) return;
    if (event.type === 'step/start' && event.data.turn === state.turn) {
      onStepStart(state, event.data.step, config.stallStepsThreshold);
      return;
    }
    if (event.type === 'step/end' && event.data.turn === state.turn) {
      finalizeStepIfNeeded(state, config.stallStepsThreshold);
      return;
    }
    if (event.type === 'turn/end' && event.data.turn === state.turn) {
      finalizeStepIfNeeded(state, config.stallStepsThreshold);
      return;
    }
    if (event.type === 'user/message' && event.data.source?.kind === SOURCE) {
      onReminderCommitted(state, event);
    }
  });

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || exec.parent !== undefined) return;
    const state = states.get(exec.agent.session);
    if (!state) return;
    recordToolResult(
      state,
      exec.name,
      Boolean(result?.isError || result?.error),
      result?.concludesTurn === true
    );
  });

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
    const state = stateFor(agent.session, turn);
    if (!state) return decision;

    finalizeStepIfNeeded(state, config.stallStepsThreshold);

    const maxReminders = config.maxRemindersPerTurn ?? 4;
    const currentStep = step ?? (state.steps + 1);

    if (state.remindersSent >= maxReminders) return decision;
    if (state.stepHasError) return decision;
    if (decision.messages.length === 0 && (state.stepToolCount === 0 || state.stepConcluded)) return decision;

    const evaluated = evaluateReminder(state, currentStep, config, ctx, agent, decision.toolSet);
    if (!evaluated) return decision;

    const reminder = createUserMessage({
      content: [{ type: 'text', text: evaluated.text }],
      source: {
        kind: SOURCE,
        form: 'notice',
        summary: evaluated.summary,
        signal: evaluated.signal
      }
    });
    return { ...decision, messages: [...decision.messages, reminder] };
  }, { prepend: true });

  return {
    getSummary(session, turn) {
      const state = session ? (turn !== undefined ? stateFor(session, turn) : states.get(session)) : null;
      return {
        steps: state?.steps ?? 0,
        reminded: Boolean(state?.reminded),
        remindersSent: state?.remindersSent ?? 0,
        reminderCharsAdded: state?.reminderCharsAdded ?? 0,
        lastReminderStep: state?.lastReminderStep ? state.lastReminderStep : null,
        lastSignal: state?.lastSignal ?? null,
        signals: state
          ? { ...state.signals }
          : { 'serial-exploration': 0, 'long-tail-stall': 0, periodic: 0 },
        consecutiveSerialReads: state?.consecutiveSerialReads ?? 0,
        stepsWithoutProgress: state?.stepsWithoutProgress ?? 0
      };
    }
  };
}

export const Config = ConvergenceConfig;
export function apply(ctx, config = {}) {
  const service = applyConvergence(ctx, config);
  if (service) ctx.provide('convergenceGuidance', service);
}
export default { name, inject, Config, apply };
