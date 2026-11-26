import assert from 'node:assert/strict';
import test from 'node:test';
import { applyContextCompaction } from '../src/context-compaction.js';

function fixture(config = {}, advanceOverflow = true, backendConfig) {
  const hooks = new Map();
  const logs = [];
  const compactionCalls = [];
  const ctx = {
    logger: { warn(message) { logs.push(message); } },
    on(name, callback) { hooks.set(name, callback); },
    get(name) {
      if (name === 'compaction') {
        return {
          config: backendConfig,
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

test('context compaction defers both hooks to an automatic host, including after host retry exhaustion', async () => {
  const host = fixture({}, true, { auto: true });
  const signal = new AbortController().signal;
  let hostPressureChecks = 0;
  await host.hooks.get('agent/pre-step')({ agent: host.agent, signal }, async () => { hostPressureChecks++; });
  assert.equal(hostPressureChecks, 1);
  const request = { agent: host.agent, turn: 1, step: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal };
  assert.deepEqual(await host.hooks.get('agent/request-error')(request, async () => ({ kind: 'retry' })), { kind: 'retry' });
  assert.equal(await host.hooks.get('agent/request-error')(request, async () => undefined), undefined);
  assert.deepEqual(host.compactionCalls, []);
});

test('context compaction bounds recovery per agent and request and honors the routed host limit', async () => {
  const host = fixture({}, true, { auto: false, maxOverflowRetries: 2,
    modelPolicies: [{ provider: 'offline', model: 'blocked', maxOverflowRetries: 0 }] });
  const signal = new AbortController().signal;
  const overflow = host.hooks.get('agent/request-error');
  const request = { agent: host.agent, turn: 1, step: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal };
  const run = overrides => overflow({ ...request, ...overrides }, async () => undefined);
  for (let i = 0; i < 2; i++) assert.deepEqual(await run(), { kind: 'retry' });
  assert.equal(await run(), undefined);
  const other = { session: { surface: { replaceGeneration: 0 } } };
  assert.deepEqual(await run({ agent: other }), { kind: 'retry' });
  host.agent.session.requestHeader = () => ({ config: { provider: 'offline', model: 'blocked' } });
  assert.equal(await run({ step: 2 }), undefined);
  delete host.agent.session.requestHeader;
  assert.deepEqual(await run({ step: 2 }), { kind: 'retry' });
  assert.deepEqual(await run({ turn: 2 }), { kind: 'retry' });
  assert.equal(host.service.getStats().overflowAttempts, 5);
});

test('context compaction does not retry overflow if disposed while compaction is in flight', async () => {
  const hooks = new Map();
  let resolveCompaction;
  const ctx = {
    on(name, callback) { hooks.set(name, callback); },
    get(name) {
      if (name !== 'compaction') return undefined;
      return {
        compactIfNeeded(agent) {
          return new Promise(resolve => {
            resolveCompaction = () => {
              agent.session.surface.replaceGeneration++;
              resolve({ shadowedSeqs: ['seq-1'] });
            };
          });
        }
      };
    }
  };
  applyContextCompaction(ctx);
  const agent = { session: { surface: { replaceGeneration: 0 } } };
  const pending = hooks.get('agent/request-error')({
    agent,
    failure: { code: 'CONTEXT_WINDOW_EXCEEDED' },
    signal: new AbortController().signal
  }, async () => ({ kind: 'reject' }));

  hooks.get('dispose')();
  resolveCompaction();
  assert.deepEqual(await pending, { kind: 'reject' });
});
