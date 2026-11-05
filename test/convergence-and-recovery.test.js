import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { CONVERGENCE_SOURCE, PAIRING_ERROR } from '../src/index.js';

test('convergence guidance injects one-time soft step budget notice without hard-stopping the turn', async () => {
  const host = await createTestRuntime({
    optimizerConfig: {
      convergence: {
        enabled: true,
        injectGuidance: true,
        softStepBudget: 2
      }
    },
    script: [
      [call('s1', 'read', { file_path: 'README.md' })],
      [call('s2', 'read', { file_path: 'README.md', offset: 2, limit: 1 })],
      [call('s3', 'read', { file_path: 'README.md', offset: 3, limit: 1 })],
      [{ type: 'text', text: 'Completed after soft budget reminder.' }]
    ]
  });

  try {
    await host.run('Inspect README.md thoroughly');
    assert.equal(host.errors.length, 0);
    assert.equal(host.requests.length, 4);

    // System prompt includes convergence guidance
    const firstRequestText = host.requests[0].messages
      .flatMap(m => m.content)
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    assert.match(firstRequestText, /Batch independent reads/);

    // Soft step budget reminder injected exactly once
    const reminders = host.events.filter(
      e => e.type === 'user/message' && e.data.source?.kind === CONVERGENCE_SOURCE
    );
    assert.equal(reminders.length, 1);

    const endEvent = host.events.filter(e => e.type === 'turn/end').at(-1);
    assert.equal(endEvent?.data.reason.kind, 'completed');
  } finally {
    await host.dispose();
  }
});

test('failureRecovery recovers a rejected large write once via retry_failed_write', async () => {
  const largeText = 'L'.repeat(9000);
  const host = await createTestRuntime({
    script: [
      [call('w-fail', 'write', {
        file_path: 'output.txt',
        content: largeText,
        justification: 'Unpaired justification'
      })],
      [call('w-retry', 'retry_failed_write', { call_id: 'w-fail' })],
      [{ type: 'text', text: 'Write recovered.' }]
    ],
    writeHandler(args, _exec, virtualFs) {
      if (args.justification && !args.sandbox_permissions) {
        throw new Error(PAIRING_ERROR);
      }
      virtualFs.set(args.file_path, args.content);
      return 'Write succeeded';
    }
  });

  try {
    await host.run('Create output.txt');
    assert.equal(host.errors.length, 0);
    assert.equal(host.virtualFs.get('output.txt'), largeText);

    const stats = host.failureRecovery.getStats(host.agent.session);
    assert.equal(stats.attempted, 1);
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.failed, 0);
  } finally {
    await host.dispose();
  }
});

test('fileMutationPolicy blocks large full-file overwrites when mode is enforce and edit is available', async () => {
  const largeOverwrite = 'X'.repeat(8500);
  const host = await createTestRuntime({
    files: {
      'existing.ts': 'export const x = 1;\n'
    },
    optimizerConfig: {
      fileMutationPolicy: {
        mode: 'enforce',
        minLargeWriteBytes: 8192
      }
    },
    script: [
      [call('r1', 'read', { file_path: 'existing.ts' })],
      [call('w1', 'write', { file_path: 'existing.ts', content: largeOverwrite })],
      [call('e1', 'edit', { file_path: 'existing.ts', old_string: 'x = 1', new_string: 'x = 2' })],
      [{ type: 'text', text: 'Used edit instead of full write.' }]
    ]
  });

  try {
    await host.run('Update existing.ts');
    assert.equal(host.errors.length, 0);
    const summary = host.fileMutationPolicy.getSummary(host.agent.session);
    assert.equal(summary.largeWriteViolations, 1);
    assert.equal(summary.largeWritesBlocked, 1);
    assert.equal(summary.editsCount, 1);
    assert.equal(host.virtualFs.get('existing.ts'), 'export const x = 2;\n');
  } finally {
    await host.dispose();
  }
});
