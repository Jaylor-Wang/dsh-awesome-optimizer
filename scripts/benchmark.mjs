import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestRuntime, call } from '../test/support/runtime.js';
import { compareTurnSummaries, PAIRING_ERROR, StdioWorkerRunner } from '../src/index.js';
import { PY_WORKER_SCRIPT } from '../src/persistent-eval/daemon-pool.js';

// Run deterministic A/B verification scenarios over the unchanged official @deepseek-ai/dsh-agent-loop.
async function runFindAndReadScenario() {
  const files = {
    'src/auth.ts': [
      ...Array.from({ length: 20 }, (_, i) => `const padAuth${i} = ${i};`),
      'export function verifyToken(token: string) {',
      '  return token.startsWith("dsh_");',
      '}',
      ...Array.from({ length: 20 }, (_, i) => `const tailAuth${i} = ${i};`)
    ].join('\n'),
    'src/session.ts': [
      ...Array.from({ length: 20 }, (_, i) => `const padSess${i} = ${i};`),
      'export function openSession(token: string) {',
      '  return verifyToken(token);',
      '}',
      ...Array.from({ length: 20 }, (_, i) => `const tailSess${i} = ${i};`)
    ].join('\n')
  };

  // Baseline: grep -> wait -> parallel reads -> final answer (3 model requests)
  const baselineHost = await createTestRuntime({
    optimizerEnabled: true,
    optimizerConfig: {
      compositeTools: { enabled: false },
      convergence: { enabled: false }
    },
    files,
    script: [
      [call('g1', 'grep', { pattern: 'verifyToken' })],
      [
        call('r1', 'read', { file_path: 'src/auth.ts', offset: 18, limit: 10 }),
        call('r2', 'read', { file_path: 'src/session.ts', offset: 18, limit: 10 })
      ],
      [{ type: 'text', text: 'Located verifyToken definition and caller.' }]
    ]
  });

  // Candidate: find_and_read collapses grep + merged context reads into 1 round-trip (2 model requests)
  const candidateHost = await createTestRuntime({
    optimizerEnabled: true,
    files,
    script: [
      [call('fr1', 'find_and_read', { pattern: 'verifyToken', contextLines: 4 })],
      [{ type: 'text', text: 'Located verifyToken definition and caller.' }]
    ]
  });

  try {
    await baselineHost.run('Find verifyToken definition and call sites.');
    await candidateHost.run('Find verifyToken definition and call sites.');

    const baseSummary = baselineHost.telemetry.getSummary(baselineHost.agent.session);
    const candSummary = candidateHost.telemetry.getSummary(candidateHost.agent.session);
    const comparison = compareTurnSummaries(baseSummary, candSummary);

    assert.equal(baseSummary.modelRequests, 3);
    assert.equal(candSummary.modelRequests, 2);
    assert.equal(candSummary.ptcSubCalls, 3); // 1 grep + 2 merged window reads
    assert.equal(comparison.modelRequests.delta, -1);

    return {
      scenario: 'find-and-read-collapse',
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

const findScenario = await runFindAndReadScenario();
const recoveryScenario = await runWriteRecoveryScenario();
const persistentEvalScenario = await runPersistentEvalBenchmarkScenario();

console.log(JSON.stringify({
  mode: 'official-loop-ab-verification',
  officialLoopReplaced: false,
  networkRequests: 0,
  note: 'Offline scripted verification proves mechanism and telemetry fidelity. Run identical live tasks to evaluate model-specific round-trip reductions.',
  scenarios: [findScenario, recoveryScenario, persistentEvalScenario]
}, null, 2));
