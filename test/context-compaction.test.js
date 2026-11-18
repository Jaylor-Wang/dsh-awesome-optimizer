import assert from 'node:assert/strict';
import test from 'node:test';
import { applyContextCompaction } from '../src/context-compaction.js';

function fixture(config = {}, advanceOverflow = true) {
  const hooks = new Map();
  const logs = [];
  const compactionCalls = [];
  const ctx = {
    logger: { warn(message) { logs.push(message); } },
    on(name, callback) { hooks.set(name, callback); },
    get(name) {
      if (name === 'compaction') {
        return {
          async compactIfNeeded(agent, trigger, signal) {
            compactionCalls.push({ agent, trigger, signal });
            if (trigger === 'context-overflow' && advanceOverflow) agent.session.surface.replaceGeneration++;
            return trigger === 'pressure' ? { shadowedSeqs: ['seq-1'] } : null;
          }
        };
      }
      return undefined;
    },
    provide() {}
  };
  const service = applyContextCompaction(ctx, config);
  const agent = { session: { surface: { replaceGeneration: 0 } } };
  return { hooks, service, agent, logs, compactionCalls };
}

test('context compaction checks pressure before steps and retries after confirmed overflow', async () => {
  const host = fixture();
  const signal = new AbortController().signal;
  await host.hooks.get('agent/pre-step')({ agent: host.agent, signal }, async () => ({ kind: 'accept' }));
  const action = await host.hooks.get('agent/request-error')({
    agent: host.agent,
    failure: { code: 'CONTEXT_WINDOW_EXCEEDED' },
    signal
  }, async () => ({ kind: 'reject' }));

  assert.equal(action.kind, 'retry');
  assert.deepEqual(host.compactionCalls.map(call => call.trigger), ['pressure', 'context-overflow']);
  assert.deepEqual(host.service.getStats(), {
    pressureAttempts: 1,
    pressureCompactions: 1,
    overflowAttempts: 1,
    overflowCompactions: 1,
    failures: 0
  });
  assert.deepEqual(host.logs, []);
});

test('context compaction remains transparent when the host seam is unavailable or disabled', async () => {
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.service, null);

  const hooks = new Map();
  const ctx = { on(name, callback) { hooks.set(name, callback); }, get() { return undefined; } };
  const service = applyContextCompaction(ctx);
  const signal = new AbortController().signal;
  const decision = await hooks.get('agent/pre-step')({ agent: {}, signal }, async () => ({ kind: 'accept' }));
  assert.deepEqual(decision, { kind: 'accept' });
  assert.deepEqual(service.getStats(), {
    pressureAttempts: 0,
    pressureCompactions: 0,
    overflowAttempts: 0,
    overflowCompactions: 0,
    failures: 0
  });
});

test('context compaction preserves the original overflow failure without durable surface progress', async () => {
  const host = fixture({}, false);
  const action = await host.hooks.get('agent/request-error')({
    agent: host.agent,
    failure: { code: 'CONTEXT_WINDOW_EXCEEDED' },
    signal: new AbortController().signal
  }, async () => ({ kind: 'reject' }));
  assert.deepEqual(action, { kind: 'reject' });
  assert.equal(host.service.getStats().overflowAttempts, 1);
  assert.equal(host.service.getStats().overflowCompactions, 0);
});
