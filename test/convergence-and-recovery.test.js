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

    // Periodic reminder injected at step 2 and step 4
    const reminders = host.events.filter(
      e => e.type === 'user/message' && e.data.source?.kind === CONVERGENCE_SOURCE
    );
    assert.equal(reminders.length, 2);
    assert.match(reminders[0].data.content[0].text, /Accelerate execution: batch remaining actions and conclude if criteria are met; NEVER omit verification\./);

    const endEvent = host.events.filter(e => e.type === 'turn/end').at(-1);
    assert.equal(endEvent?.data.reason.kind, 'completed');
  } finally {
    await host.dispose();
  }
});

test('convergence guidance injects periodic micro-directive, caps at maxRemindersPerTurn, and suppresses on tool error', async () => {
  const host = await createTestRuntime({
    files: {
      'ok.txt': 'all good'
    },
    optimizerConfig: {
      convergence: {
        enabled: true,
        stepInterval: 2,
        maxRemindersPerTurn: 2
      }
    },
    readHandler(args) {
      if (args.file_path === 'error.txt') {
        throw new Error('intentional-tool-failure');
      }
      return 'ok-content';
    },
    script: [
      // Step 1: Tool execution fails
      [call('c1', 'read', { file_path: 'error.txt' })],
      // Step 2: step 2 >= interval 2, BUT step 1 had error -> reminder suppressed!
      [call('c2', 'read', { file_path: 'ok.txt' })],
      // Step 3: step 2 was clean -> reminder 1 injected!
      [call('c3', 'read', { file_path: 'ok.txt' })],
      // Step 4: step 4 meets next due (2 * 2 = 4) -> reminder 2 injected!
      [call('c4', 'read', { file_path: 'ok.txt' })],
      // Step 5
      [call('c5', 'read', { file_path: 'ok.txt' })],
      // Step 6: step 6 >= 3 * 2, BUT maxRemindersPerTurn (2) is reached -> suppressed!
      [{ type: 'text', text: 'Concluded task.' }]
    ]
  });

  try {
    await host.run('Run long task with tool error and recovery');
    assert.equal(host.errors.length, 0);

    const reminders = host.events.filter(
      e => e.type === 'user/message' && e.data.source?.kind === CONVERGENCE_SOURCE
    );
    // Injected exactly twice (capped at maxRemindersPerTurn = 2)
    assert.equal(reminders.length, 2);
    for (const r of reminders) {
      assert.match(r.data.content[0].text, /Accelerate execution: batch remaining actions and conclude if criteria are met; NEVER omit verification\./);
    }

    const summary = host.agent.session
      ? host.ctx.get('convergenceGuidance').getSummary(host.agent.session)
      : null;
    assert.equal(summary?.remindersSent, 2);
    assert.equal(summary?.reminded, true);
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

test('fileMutationPolicy blocks large full-file overwrites via ctx.fs backend check even without prior read', async () => {
  const largeOverwrite = 'Z'.repeat(8500);
  const host = await createTestRuntime({
    files: {
      'backend-only-file.ts': 'export const backend = "data";\n'
    },
    optimizerConfig: {
      fileMutationPolicy: {
        mode: 'enforce',
        minLargeWriteBytes: 8192
      }
    },
    script: [
      // Direct write without any prior read in this turn:
      [call('w-blind', 'write', { file_path: 'backend-only-file.ts', content: largeOverwrite })],
      [call('e-fix', 'edit', { file_path: 'backend-only-file.ts', old_string: '"data"', new_string: '"updated"' })],
      [{ type: 'text', text: 'Blocked overwrite and switched to edit.' }]
    ]
  });

  try {
    await host.run('Overwrite backend-only-file.ts blindly');
    assert.equal(host.errors.length, 0);
    const summary = host.fileMutationPolicy.getSummary(host.agent.session);
    assert.equal(summary.largeWriteViolations, 1);
    assert.equal(summary.largeWritesBlocked, 1);
    assert.equal(summary.editsCount, 1);
    assert.equal(host.virtualFs.get('backend-only-file.ts'), 'export const backend = "updated";\n');
  } finally {
    await host.dispose();
  }
});

test('failureRecovery preserves pending retry_failed_write across non-mutating eval_python calls', async () => {
  const largeText = 'M'.repeat(9000);
  const host = await createTestRuntime({
    script: [
      [call('w-fail', 'write', {
        file_path: 'computed.txt',
        content: largeText,
        justification: 'Unpaired justification'
      })],
      [call('eval-check', 'eval_python', { code: '2 + 2' })],
      [call('w-retry', 'retry_failed_write', { call_id: 'w-fail' })],
      [{ type: 'text', text: 'Recovered after eval.' }]
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
    await host.run('Create computed.txt with intermediate eval');
    assert.equal(host.errors.length, 0);
    assert.equal(host.virtualFs.get('computed.txt'), largeText);

    const stats = host.failureRecovery.getStats(host.agent.session);
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.invalidated, 0);
  } finally {
    await host.dispose();
  }
});

