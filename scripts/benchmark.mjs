import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestRuntime, call } from '../test/support/runtime.js';
import { compareTurnSummaries, PAIRING_ERROR, StdioWorkerRunner } from '../src/index.js';
import { PY_WORKER_SCRIPT } from '../src/persistent-eval/daemon-pool.js';

// Run deterministic A/B verification scenarios over the unchanged official @deepseek-ai/dsh-agent-loop.
async function runBatchReadScenario() {
  const files = {
    'a.txt': 'Alpha content line 1\nAlpha content line 2',
    'b.txt': 'Beta content line 1\nBeta content line 2',
    'c.txt': 'Gamma content line 1\nGamma content line 2'
  };

  // Baseline: sequential single-file reads across 3 steps + final answer (4 model requests)
  const baselineHost = await createTestRuntime({
    optimizerEnabled: true,
    optimizerConfig: {
      compositeTools: { enabled: false },
      convergence: { enabled: false }
    },
    files,
    script: [
      [call('r1', 'read', { file_path: 'a.txt' })],
      [call('r2', 'read', { file_path: 'b.txt' })],
      [call('r3', 'read', { file_path: 'c.txt' })],
      [{ type: 'text', text: 'Synthesized alpha, beta, gamma.' }]
    ]
  });

  // Candidate: read_batch collapses 3 file reads into 1 round-trip + final answer (2 model requests)
  const candidateHost = await createTestRuntime({
    optimizerEnabled: true,
    files,
    script: [
      [call('rb1', 'read_batch', {
        files: [
          { file_path: 'a.txt' },
          { file_path: 'b.txt' },
          { file_path: 'c.txt' }
        ]
      })],
      [{ type: 'text', text: 'Synthesized alpha, beta, gamma.' }]
    ]
  });

  try {
    await baselineHost.run('Read a.txt, b.txt, and c.txt and summarize.');
    await candidateHost.run('Read a.txt, b.txt, and c.txt and summarize.');

    const baseSummary = baselineHost.telemetry.getSummary(baselineHost.agent.session);
    const candSummary = candidateHost.telemetry.getSummary(candidateHost.agent.session);
    const comparison = compareTurnSummaries(baseSummary, candSummary);

    assert.equal(baseSummary.modelRequests, 4);
    assert.equal(candSummary.modelRequests, 2);
    assert.equal(candSummary.ptcSubCalls, 3);
    assert.equal(comparison.modelRequests.delta, -2);

    return {
      scenario: 'multi-file-read-collapse',
      baseline: baseSummary,
      candidate: candSummary,
      comparison
    };
  } finally {
    await baselineHost.dispose();
    await candidateHost.dispose();
  }
}

async function runWriteRecoveryScenario() {
  const largePayload = 'x'.repeat(9000);
  const host = await createTestRuntime({
    optimizerEnabled: true,
    script: [
      [call('w1', 'write', {
        file_path: 'deliverable.txt',
        content: largePayload,
        justification: 'Unpaired justification rejected when approval prompts are disabled'
      })],
      [call('rw1', 'retry_failed_write', { call_id: 'w1' })],
      [{ type: 'text', text: 'Recovered large write without regenerating 9KB content.' }]
    ],
    writeHandler(args) {
      if (args.justification && !args.sandbox_permissions) {
        throw new Error(PAIRING_ERROR);
      }
      return `Wrote ${args.file_path} (${args.content.length} bytes)`;
    }
  });

  try {
    await host.run('Write deliverable.txt.');
    const summary = host.telemetry.getSummary(host.agent.session);
    assert.equal(summary.failureRecovery?.succeeded, 1);
    return {
      scenario: 'failed-large-write-recovery',
      summary
    };
  } finally {
    await host.dispose();
  }
}

async function runPersistentEvalBenchmarkScenario() {
  const code = 'import math\nr = math.sqrt(144) + 10\nprint(f"r={r}")';

  // 1. Baseline: 3 consecutive cold process launches via python
  const coldDurations = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const res = spawnSync('python', ['-c', code], { encoding: 'utf-8' });
    const t1 = performance.now();
    assert.equal(res.status, 0);
    coldDurations.push(t1 - t0);
  }
  const avgColdMs = Number((coldDurations.reduce((a, b) => a + b, 0) / coldDurations.length).toFixed(2));

  // 2. Candidate: persistent eval worker (hot stateful execution)
  const runner = new StdioWorkerRunner({
    command: 'python',
    args: ['-u', PY_WORKER_SCRIPT]
  });

  await runner.ensureStarted();
  const hotDurations = [];
  try {
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await runner.execute(code);
      const t1 = performance.now();
      assert.equal(res.success, true);
      hotDurations.push(t1 - t0);
    }
  } finally {
    runner.destroy();
  }
  const avgHotMs = Number((hotDurations.reduce((a, b) => a + b, 0) / hotDurations.length).toFixed(2));
  const speedupRatio = Number(((avgColdMs - avgHotMs) / avgColdMs * 100).toFixed(1));

  assert.ok(avgHotMs <= 15, `Expected hot execution <= 15ms but got ${avgHotMs}ms`);
  assert.ok(speedupRatio >= 85, `Expected speedup >= 85% but got ${speedupRatio}%`);

  return {
    scenario: 'persistent-kernel-vs-cold-spawn',
    baselineAvgColdMs: avgColdMs,
    candidateAvgHotMs: avgHotMs,
    speedupPercentage: `${speedupRatio}%`,
    targetMet: true
  };
}

const batchScenario = await runBatchReadScenario();
const recoveryScenario = await runWriteRecoveryScenario();
const persistentEvalScenario = await runPersistentEvalBenchmarkScenario();

console.log(JSON.stringify({
  mode: 'official-loop-ab-verification',
  officialLoopReplaced: false,
  networkRequests: 0,
  note: 'Offline scripted verification proves mechanism and telemetry fidelity. Run identical live tasks to evaluate model-specific round-trip reductions.',
  scenarios: [batchScenario, recoveryScenario, persistentEvalScenario]
}, null, 2));
