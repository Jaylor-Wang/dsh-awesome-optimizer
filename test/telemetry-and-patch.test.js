import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestRuntime, call } from './support/runtime.js';
import { compareTurnSummaries } from '../src/index.js';
import { AgentTelemetryManager } from '../src/telemetry.js';

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
  assert.match(patchText, /name:\s*dsh-plugin-agent-optimizer/);

  const srcDir = path.join(root, 'src');
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.js')) continue;
    const code = fs.readFileSync(path.join(srcDir, entry), 'utf8');
    // Verify we never hook agent/request to mutate model or reasoning parameters
    assert.doesNotMatch(code, /\.(?:on|waterfall)\(\s*['"]agent\/request['"]/);
  }
});
