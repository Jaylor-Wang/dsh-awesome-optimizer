import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'agent-optimizer-convergence';
export const inject = ['systemPrompt', 'tools'];
export const SOURCE = 'optimizer-convergence';

export const GUIDANCE = [
  "Work toward the user's completion criteria with as few model round trips as practical.",
  'Batch independent reads, searches, and checks in a single response when their inputs are known (or use read_batch for multi-file reads); preserve dependencies and exclusive tool barriers.',
  'Before emitting a large payload, write deliverables or reusable scripts to disk using native write and execute by file path. Never embed complete files or large scripts in shell arguments (node -e, python -c, pwsh -Command).',
  'For localized revisions on existing files, reuse context already in the conversation and prefer native edit with an unambiguous match over rewriting the entire file.',
  'After receiving tool results, make the next complete useful decision without repeating equivalent searches or checks unless new evidence justifies them.',
  'This efficiency guidance never overrides the user, correctness, permission checks, required verification, or cancellation.'
].join('\n');

export const REMINDER = [
  'The soft step budget for this turn has been reached. Reassess the remaining completion criteria using the evidence already available.',
  'If the task and required verification are complete, provide the final result now. Otherwise, perform the specific remaining work: batch independent operations, reuse established context, prefer native edit for localized revisions, and keep large payloads in files.',
  'This is a one-time efficiency reminder, not a hard step limit or permission to omit required verification.'
].join('\n');

export const ConvergenceConfig = z.object({
  enabled: z.boolean().default(true),
  injectGuidance: z.boolean().default(true),
  softStepBudget: z.number().step(1).min(1).max(10000).default(8)
});

/**
 * Add lightweight convergence guidance and a one-time soft step budget notice
 * without taking over the official loop's control flow or termination semantics.
 */
export function applyConvergence(ctx, raw = {}) {
  const config = ConvergenceConfig(raw);
  if (!config.enabled) return null;

  const states = new WeakMap();
  const stateFor = (session, turn) => {
    if (!session) return null;
    let state = states.get(session);
    if (!state || state.turn !== turn) {
      state = {
        turn,
        steps: 0,
        reminded: false,
        remindersSent: 0,
        reminderCharsAdded: 0,
        toolResults: 0,
        concluded: false
      };
      if (typeof session.snapshotEvents === 'function') {
        for (const event of session.snapshotEvents()) {
          if (event.type === 'step/start' && event.data.turn === turn) state.steps++;
          if (event.type === 'turn/start' && event.data.turn === turn) state.startSeq = event.seq;
          if (event.type === 'user/message' && event.data.source?.kind === SOURCE && event.seq > (state.startSeq ?? Infinity)) {
            state.reminded = true;
            state.remindersSent++;
            state.reminderCharsAdded += REMINDER.length;
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
      text: GUIDANCE,
      interpolate: false
    });
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, {
        turn: event.data.turn,
        steps: 0,
        reminded: false,
        remindersSent: 0,
        reminderCharsAdded: 0,
        startSeq: event.seq,
        toolResults: 0,
        concluded: false
      });
      return;
    }
    const state = states.get(session);
    if (!state) return;
    if (event.type === 'step/start' && event.data.turn === state.turn) {
      state.steps++;
      state.toolResults = 0;
      state.concluded = false;
    }
    if (event.type === 'user/message' && event.data.source?.kind === SOURCE) {
      state.reminded = true;
      state.remindersSent++;
      state.reminderCharsAdded += REMINDER.length;
    }
  });

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    const state = states.get(exec.agent.session);
    if (!state) return;
    state.toolResults++;
    state.concluded ||= result.concludesTurn === true;
  });

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
    const state = stateFor(agent.session, turn);
    if (!state || state.reminded || state.steps < config.softStepBudget) return decision;
    if (decision.messages.length === 0 && (state.toolResults === 0 || state.concluded)) return decision;
    const reminder = createUserMessage({
      content: [{ type: 'text', text: REMINDER }],
      source: {
        kind: SOURCE,
        form: 'notice',
        summary: 'Reassess remaining work after the soft step budget.'
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
        reminderCharsAdded: state?.reminderCharsAdded ?? 0
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
