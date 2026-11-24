import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTestRuntime, call } from './support/runtime.js';
import { compareTurnSummaries } from '../src/index.js';
import { AgentTelemetryManager } from '../src/telemetry.js';
import { OutlineCache } from '../src/outline-cache.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('agentTelemetry tracks parallel tool batches, token usage, prefix stability, and A/B deltas', async () => {
  let callbackSummary = null;
  const host = await createTestRuntime({
    files: {
      'f1.txt': 'one',
      'f2.txt': 'two',
      'f3.txt': 'three'
    },
    optimizerConfig: {
      telemetry: {
        enabled: true,
        trackStreams: true,
        onTurnSummary(summary) {
          callbackSummary = summary;
        }
      }
    },
    script: [
      // Step 1: 3 parallel tool calls in a single batch
      [
        call('p1', 'read', { file_path: 'f1.txt' }),
        call('p2', 'read', { file_path: 'f2.txt' }),
        call('p3', 'read', { file_path: 'f3.txt' })
      ],
      [{ type: 'text', text: 'Read all three in parallel.' }]
    ]
  });

  try {
    await host.run('Read f1, f2, f3 in parallel');
    assert.equal(host.errors.length, 0);

    const summary = host.telemetry.getSummary(host.agent.session);
    assert.ok(callbackSummary);
    assert.equal(summary.modelRequests, 2);
    assert.equal(summary.toolCalls, 3);
    assert.equal(summary.toolBatches, 1);
    assert.equal(summary.maxBatchSize, 3);
    assert.equal(summary.parallelismRatio, 3);
    assert.equal(summary.prefixChanges, 0);
    assert.equal(summary.usage.inputTokens, 240);
    assert.equal(summary.usage.outputTokens, 80);
    assert.equal(summary.turnOutcome, 'completed');
    assert.deepEqual(summary.readGuard, host.readGuard.getStats(host.agent.session));
    assert.deepEqual(callbackSummary.readGuard, summary.readGuard);
    assert.equal(summary.readGuard.outlineCacheHitRate, null);
    assert.deepEqual(summary.editRecovery, host.editRecovery.getStats(host.agent.session));
    assert.deepEqual(summary.contextCompaction, host.ctx.get('contextCompaction').getStats());
    assert.deepEqual(summary.convergenceGuidance, host.ctx.get('convergenceGuidance').getSummary(host.agent.session, summary.turn));

    const sequentialBaseline = {
      modelRequests: 4,
      toolCalls: 3,
      parallelismRatio: 1,
      failedToolCalls: 0,
      wallClockMs: summary.wallClockMs + 50,
      usage: { inputTokens: 480, outputTokens: 160, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prefixChanges: 0,
      turnOutcome: 'completed'
    };

    const delta = compareTurnSummaries(sequentialBaseline, summary);
    assert.equal(delta.modelRequests.delta, -2);
    assert.equal(delta.parallelismRatio.delta, 2);
    assert.equal(delta.inputTokens.delta, -240);
    assert.equal(delta.bothCompleted, true);
  } finally {
    await host.dispose();
  }
});

test('official loop reports detached cache summaries across turns and releases them on session disposal', async t => {
  const cleared = [];
  const clear = OutlineCache.prototype.clear;
  t.mock.method(OutlineCache.prototype, 'clear', function () {
    clear.call(this);
    cleared.push(this);
  });
  const summaries = [];
  const source = 'head\nexport function hiddenTail() {}';
  const host = await createTestRuntime({
    files: { 'source.ts': source },
    optimizerConfig: {
      persistentEval: { enabled: false },
      telemetry: { onTurnSummary(summary) { summaries.push(summary); } }
    },
    configureTools(ctx) {
      ctx.get('fs').readBytes = async () => Buffer.from(source);
    },
    readHandler: () => '<content>\n1: head\n\n(Showing lines 1-1 of 2. Use offset=2 to continue.)\n</content>',
    script: [
      [call('cache-first', 'read', { file_path: 'source.ts' })],
      [call('cache-second', 'read', { file_path: 'source.ts' })],
      [{ type: 'text', text: 'First turn complete.' }],
      [call('cache-next-turn', 'read', { file_path: 'source.ts' })],
      [{ type: 'text', text: 'Second turn complete.' }]
    ]
  });
  try {
    await host.run('Read the same truncated file twice');
    assert.equal(host.errors.length, 0);
    const first = summaries[0].readGuard;
    assert.equal(first.outlineCacheLookups, 2);
    assert.equal(first.outlineCacheHits, 1);
    assert.equal(first.outlineCacheMisses, 1);
    assert.equal(first.outlineCacheHitRate, 0.5);
    assert.equal(summaries[0].prefixChanges, 0);
    await host.run('Read it again in the next turn');
    assert.equal(host.errors.length, 0);
    assert.equal(summaries[1].readGuard.outlineCacheLookups, 1);
    assert.equal(summaries[1].readGuard.outlineCacheHits, 1);
    assert.equal(summaries[1].readGuard.outlineCacheHitRate, 1);
    assert.equal(first.outlineCacheLookups, 2);
    assert.equal(first.outlineCacheHitRate, 0.5);
    await host.handles[0].dispose();
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].entries.size, 0);
    assert.equal(cleared[0].bytes, 0);
    assert.equal(host.readGuard.getStats(host.agent.session).inspected, 0);
  } finally { await host.dispose(); }
  assert.equal(cleared.length, 1);
});

test('telemetry exposes null readGuard summaries when no session or guard is available', () => {
  const manager = new AgentTelemetryManager({ get: () => undefined });
  const empty = manager.getSummary();
  assert.equal(empty.readGuard, null);
  assert.equal(empty.editRecovery, null);
  assert.equal(empty.contextCompaction, null);
  assert.equal(empty.convergenceGuidance, null);
  const session = { id: 'weak-ref-session' };
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  assert.ok(manager.sessionsById.get('weak-ref-session') instanceof WeakRef);
  const active = manager.getSummary(session);
  assert.equal(active.readGuard, null);
  assert.equal(active.editRecovery, null);
  assert.equal(active.contextCompaction, null);
  assert.equal(active.convergenceGuidance, null);
});

test('querying an unavailable turn leaves live telemetry and policy state untouched', async () => {
  const host = await createTestRuntime({
    script: [[{ type: 'text', text: 'First turn.' }],
      [call('read-current', 'read', { file_path: 'README.md' })],
      async function* () {
        const session = host.agent.session;
        const current = host.telemetry.getSummary(session);
        assert.equal(current.toolCalls, 1);
        assert.equal(current.runtimePolicy.toolExecutions, 1);
        assert.equal(current.fileMutationPolicy.observedFiles, 1);
        for (const unavailable of [current.turn - 1, current.turn + 1]) {
          const empty = host.telemetry.getSummary(session, unavailable);
          assert.equal(empty.turn, unavailable);
          assert.equal(empty.modelRequests, 0);
          assert.equal(empty.runtimePolicy, null);
          assert.equal(host.runtimePolicy.getSummary(session, unavailable).toolExecutions, 0);
          assert.equal(host.fileMutationPolicy.getSummary(session, unavailable).observedFiles, 0);
        }
        yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }]
  });
  try {
    await host.run('First turn');
    await host.run('Second turn');
    const current = host.telemetry.getSummary(host.agent.session);
    assert.equal(current.turnOutcome, 'completed');
    assert.equal(current.modelRequests, 2);
    assert.equal(current.toolCalls, 1);
    assert.equal(current.runtimePolicy.toolExecutions, 1);
    assert.equal(current.fileMutationPolicy.observedFiles, 1);
    assert.equal(current.usage.inputTokens, 137);
  } finally { await host.dispose(); }
});

test('turn end handles callback failures without waiting for async callbacks', async () => {
  const session = {};
  const received = [];
  let rejectCallback;
  const pending = new Promise((_, reject) => { rejectCallback = reject; });
  const manager = new AgentTelemetryManager({ get: () => undefined }, {
    onTurnSummary(summary, source) {
      received.push([summary.turn, source]);
      if (summary.turn === 1) throw new Error('sync observer failure');
      return pending;
    }
  });

  for (const turn of [1, 2]) {
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn } });
    const result = manager.onSessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    assert.equal(result, undefined);
    assert.equal(manager.getSummary(session).turnOutcome, 'completed');
  }
  assert.deepEqual(received, [[1, session], [2, session]]);
  rejectCallback(new Error('async observer failure'));
  // node:test treats any unhandled rejection as a failure.
  await setImmediate();
});

test('turn cache coverage counts explicit zero and excludes missing counters per stream attempt', async () => {
  const manager = new AgentTelemetryManager({ get: () => undefined });
  const session = { id: 'cache-coverage' };
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  const report = async (...snapshots) => {
    for await (const _ of manager.wrapStream({ sessionId: session.id }, async function* () {
      for (const usage of snapshots) yield { type: 'usage', usage };
    })) {}
  };
  await report({ inputTokens: 148358, outputTokens: 166 });
  assert.equal(manager.getSummary(session).usage.cacheReadTokens, null);
  assert.equal(manager.getSummary(session).usage.cacheWriteTokens, null);
  assert.deepEqual(manager.getSummary(session).cacheUsageCoverage, { streamAttempts: 1, readReported: 0, writeReported: 0 });
  await report({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(manager.getSummary(session).usage.cacheReadTokens, 0);
  await report({ cacheReadTokens: 30 }, { cacheReadTokens: 38 }, { inputTokens: 50 });
  await report();
  const summary = manager.getSummary(session);
  assert.equal(summary.usage.cacheReadTokens, 38);
  assert.equal(summary.usage.cacheWriteTokens, 0);
  assert.deepEqual(summary.cacheUsageCoverage, { streamAttempts: 4, readReported: 2, writeReported: 1 });
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } });
  manager.onSessionEvent(session, { type: 'assistant/message', data: { turn: 2 } });
  const untracked = manager.getSummary(session);
  assert.equal(untracked.modelRequests, 1);
  assert.equal(untracked.usage.cacheReadTokens, null);
  assert.deepEqual(untracked.cacheUsageCoverage, { streamAttempts: 0, readReported: 0, writeReported: 0 });
});

test('agentTelemetry attributes interleaved streams to their session IDs', async () => {
  const manager = new AgentTelemetryManager({ get: () => undefined });
  const sessionA = { id: 'session-a' };
  const sessionB = { id: 'session-b' };
  manager.onSessionEvent(sessionA, { type: 'turn/start', data: { turn: 1 } });
  manager.onSessionEvent(sessionB, { type: 'turn/start', data: { turn: 1 } });

  async function* usageStream(inputTokens) {
    yield { type: 'usage', usage: { inputTokens, outputTokens: 1 } };
  }

  const streamA = manager.wrapStream({ sessionId: 'session-a', messages: [] }, () => usageStream(11));
  const streamB = manager.wrapStream({ sessionId: 'session-b', messages: [] }, () => usageStream(29));
  await Promise.all([
    (async () => { for await (const _chunk of streamA) {} })(),
    (async () => { for await (const _chunk of streamB) {} })()
  ]);

  assert.equal(manager.getSummary(sessionA).modelRequests, 1);
  assert.equal(manager.getSummary(sessionA).usage.inputTokens, 11);
  assert.equal(manager.getSummary(sessionB).modelRequests, 1);
  assert.equal(manager.getSummary(sessionB).usage.inputTokens, 29);

  manager.onSessionDisposed(sessionA);
  for await (const _chunk of manager.wrapStream(
    { sessionId: 'session-a', messages: [] },
    () => usageStream(101)
  )) {}
  assert.equal(manager.getSummary(sessionA).usage.inputTokens, 11);
});

test('cordis.patch.yml and source files preserve official loop ownership and never mutate agent/request', () => {
  const patchText = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(patchText, /disabled:\s*true/);
  assert.match(patchText, /name:\s*dsh-awesome-optimizer/);
  assert.match(patchText, /persistentEval:\s*\n\s*enabled:\s*true/);

  const srcDir = path.join(root, 'src');
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.js')) continue;
    const code = fs.readFileSync(path.join(srcDir, entry), 'utf8');
    // Verify we never hook agent/request to mutate model or reasoning parameters
    assert.doesNotMatch(code, /\.(?:on|waterfall)\(\s*['"]agent\/request['"]/);
  }
});

test('agentTelemetry detects replacement, in-place and cross-turn prefix changes', async () => {
  const manager = new AgentTelemetryManager({ get: () => undefined });
  const session = { id: 'sess-prefix-cache' };
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });

  const msg1 = { role: 'system', content: [{ type: 'text', text: 'sys' }] };
  const msg2 = { role: 'user', content: [{ type: 'text', text: 'hello' }] };

  async function* emptyStream() {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
  }

  for await (const _ of manager.wrapStream({ sessionId: 'sess-prefix-cache', messages: [msg1, msg2] }, emptyStream)) {}
  for await (const _ of manager.wrapStream({ sessionId: 'sess-prefix-cache', messages: [msg1, msg2, { role: 'assistant', content: [] }] }, emptyStream)) {}
  assert.equal(manager.getSummary(session).prefixChanges, 0);

  const mutatedMsg1 = { role: 'system', content: [{ type: 'text', text: 'sys-changed' }] };
  for await (const _ of manager.wrapStream({ sessionId: 'sess-prefix-cache', messages: [mutatedMsg1, msg2] }, emptyStream)) {}
  assert.equal(manager.getSummary(session).prefixChanges, 1);
  mutatedMsg1.content[0].text = 'in-place';
  for await (const _ of manager.wrapStream({ sessionId: session.id, messages: [mutatedMsg1, msg2] }, emptyStream)) {}
  assert.equal(manager.getSummary(session).prefixChanges, 2);
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } });
  msg2.content[0].text = 'changed-across-turns';
  for await (const _ of manager.wrapStream({ sessionId: session.id, messages: [mutatedMsg1, msg2] }, emptyStream)) {}
  assert.equal(manager.getSummary(session).prefixChanges, 1);
});

test('agentTelemetry.getSummary tolerates throwing ctx.get lookups without breaking summary or callback', () => {
  let receivedSummary = null;
  const ctx = {
    get(key) {
      if (key === 'readGuard' || key === 'runtimePolicy') {
        throw new Error(`service ${key} unavailable`);
      }
      if (key === 'contextCompaction') {
        return { getStats: () => ({ pressureAttempts: 2, pressureCompactions: 1, overflowAttempts: 0, overflowCompactions: 0, failures: 0 }) };
      }
      return undefined;
    }
  };
  const manager = new AgentTelemetryManager(ctx, {
    onTurnSummary(summary) {
      receivedSummary = summary;
    }
  });
  const session = { id: 'throwing-ctx-session' };
  manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  manager.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  const summary = manager.getSummary(session, 1);
  assert.equal(summary.runtimePolicy, null);
  assert.equal(summary.readGuard, null);
  assert.deepEqual(summary.contextCompaction, {
    pressureAttempts: 2,
    pressureCompactions: 1,
    overflowAttempts: 0,
    overflowCompactions: 0,
    failures: 0
  });
  assert.ok(receivedSummary);
  assert.equal(receivedSummary.turnOutcome, 'completed');
});
