import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { applyConvergence, buildGuidance, CONVERGENCE_SOURCE, PAIRING_ERROR, REMINDER } from '../src/index.js';

function findConvergenceEvents(events) {
  return events.filter(e => e.type === 'user/message' && e.data.source?.kind === CONVERGENCE_SOURCE);
}

function findReminderTriggerSteps(requests, matcher = text => text === REMINDER || /^\[Step \d+:/.test(text)) {
  const triggerSteps = [];
  let seen = 0;
  for (let i = 0; i < requests.length; i++) {
    const count = requests[i].messages.filter(m =>
      m.role === 'user'
      && Array.isArray(m.content)
      && m.content.some(b => b.type === 'text' && matcher(b.text))
    ).length;
    if (count > seen) {
      triggerSteps.push(i + 1);
      seen = count;
    }
  }
  return triggerSteps;
}

function firstRequestText(requests) {
  return requests[0].messages
    .flatMap(m => m.content)
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

test('adaptive convergence detects consecutive single-tool serial reads, enforces cooldown, and adapts to admitted tools', async () => {
  const files = { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' };
  const host = await createTestRuntime({
    files,
    optimizerConfig: {
      customPrompt: { enabled: false },
      convergence: {
        enabled: true,
        injectGuidance: true,
        serialReadThreshold: 3,
        cooldownSteps: 3,
        longTailStepThreshold: 20,
        maxRemindersPerTurn: 2
      }
    },
    script: [
      [call('s1', 'read', { file_path: 'a.txt' })],
      [call('s2', 'read', { file_path: 'b.txt' })],
      [call('s3', 'read', { file_path: 'c.txt' })],
      // Step 4: 3 consecutive single-tool reads -> serial-exploration #1
      [call('s4', 'read', { file_path: 'd.txt' })],
      // Step 5 & 6: suppressed by cooldownSteps (4 + 3 = 7)
      [call('s5', 'read', { file_path: 'a.txt' })],
      [call('s6', 'read', { file_path: 'b.txt' })],
      // Step 7: cooldown elapsed (6 consecutive serial reads) -> serial-exploration #2
      [call('s7', 'read', { file_path: 'c.txt' })],
      [call('s8', 'read', { file_path: 'd.txt' })],
      [call('s9', 'read', { file_path: 'a.txt' })],
      // Step 10: capped at maxRemindersPerTurn = 2
      [{ type: 'text', text: 'Done after adaptive serial reminders.' }]
    ]
  });

  try {
    await host.run('Inspect files one by one');
    assert.equal(host.errors.length, 0);

    const prompt = firstRequestText(host.requests);
    assert.match(prompt, /use find_and_read/);
    assert.match(prompt, /edit_batch/);
    assert.doesNotMatch(prompt, /npm publish/);

    const reminders = findConvergenceEvents(host.events);
    assert.equal(reminders.length, 2);
    assert.deepEqual(findReminderTriggerSteps(host.requests), [4, 7]);
    assert.equal(reminders[0].data.source.signal, 'serial-exploration');
    assert.match(reminders[0].data.content[0].text, /^\[Step 4: 3 consecutive single-tool reads\] Batch independent reads in parallel or use find_and_read;/);
    assert.match(reminders[1].data.content[0].text, /^\[Step 7: 6 consecutive single-tool reads\]/);

    const summary = host.ctx.get('convergenceGuidance').getSummary(host.agent.session);
    assert.equal(summary.reminded, true);
    assert.equal(summary.remindersSent, 2);
    assert.equal(summary.lastReminderStep, 7);
    assert.equal(summary.lastSignal, 'serial-exploration');
    assert.equal(summary.signals['serial-exploration'], 2);
    assert.equal(summary.signals['long-tail-stall'], 0);
    assert.equal(
      summary.reminderCharsAdded,
      reminders.reduce((sum, r) => sum + r.data.content[0].text.length, 0)
    );
    assert.equal(host.telemetry.getSummary(host.agent.session).prefixChanges, 0);
  } finally {
    await host.dispose();
  }

  // Without compositeTools, both static guidance and serial reminder omit find_and_read / edit_batch
  const hostNoComposite = await createTestRuntime({
    files,
    optimizerConfig: {
      customPrompt: { enabled: false },
      compositeTools: { enabled: false },
      convergence: {
        enabled: true,
        injectGuidance: true,
        serialReadThreshold: 3,
        cooldownSteps: 4
      }
    },
    script: [
      [call('n1', 'read', { file_path: 'a.txt' })],
      [call('n2', 'read', { file_path: 'b.txt' })],
      [call('n3', 'read', { file_path: 'c.txt' })],
      [{ type: 'text', text: 'Done without composite tools.' }]
    ]
  });

  try {
    await hostNoComposite.run('Read without composite tools');
    assert.equal(hostNoComposite.errors.length, 0);
    const prompt = firstRequestText(hostNoComposite.requests);
    assert.doesNotMatch(prompt, /find_and_read/);
    assert.doesNotMatch(prompt, /edit_batch/);

    const reminders = findConvergenceEvents(hostNoComposite.events);
    assert.equal(reminders.length, 1);
    assert.doesNotMatch(reminders[0].data.content[0].text, /find_and_read/);
    assert.match(reminders[0].data.content[0].text, /^\[Step 4: 3 consecutive single-tool reads\] Batch independent read\/search calls in parallel;/);
  } finally {
    await hostNoComposite.dispose();
  }
});

test('adaptive convergence detects long-tail stall, stays silent on healthy active tasks, and stretches threshold for high-parallel audits', async () => {
  // 1. Long-tail stall with non-parallel find_and_read (does not trip serial-exploration early)
  const files = {
    'src.js': 'export const alpha = 1;\nexport const beta = 2;\n'
  };
  const stallHost = await createTestRuntime({
    files,
    optimizerConfig: {
      convergence: {
        enabled: true,
        serialReadThreshold: 3,
        longTailStepThreshold: 6,
        stallStepsThreshold: 4,
        cooldownSteps: 4
      }
    },
    script: [
      [call('f1', 'find_and_read', { pattern: 'alpha' })],
      [call('f2', 'find_and_read', { pattern: 'beta' })],
      [call('f3', 'find_and_read', { pattern: 'alpha' })],
      [call('f4', 'find_and_read', { pattern: 'beta' })],
      [call('f5', 'find_and_read', { pattern: 'alpha' })],
      // Step 6: >= longTailStepThreshold(6) and stepsWithoutProgress(5) >= stallStepsThreshold(4) -> long-tail-stall!
      [call('e1', 'edit', { file_path: 'src.js', old_string: 'alpha = 1', new_string: 'alpha = 9' })],
      // Step 7..9: edit reset stepsWithoutProgress -> silent
      [call('f6', 'find_and_read', { pattern: 'alpha' })],
      [call('f7', 'find_and_read', { pattern: 'beta' })],
      [{ type: 'text', text: 'Updated after long-tail notice.' }]
    ]
  });

  try {
    await stallHost.run('Investigate and update src.js');
    assert.equal(stallHost.errors.length, 0);
    const reminders = findConvergenceEvents(stallHost.events);
    assert.equal(reminders.length, 1);
    assert.deepEqual(findReminderTriggerSteps(stallHost.requests), [6]);
    assert.equal(reminders[0].data.source.signal, 'long-tail-stall');
    assert.match(reminders[0].data.content[0].text, /^\[Step 6: 5 steps without edits or verification\] Synthesize findings/);

    const summary = stallHost.ctx.get('convergenceGuidance').getSummary(stallHost.agent.session);
    assert.equal(summary.signals['long-tail-stall'], 1);
    assert.equal(summary.signals['serial-exploration'], 0);
    assert.equal(summary.stepsWithoutProgress, 2);
  } finally {
    await stallHost.dispose();
  }

  // 2. Healthy active implementation with interleaved edits and bash tests stays completely silent
  const activeHost = await createTestRuntime({
    files: { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 1;\n' },
    optimizerConfig: {
      convergence: {
        enabled: true,
        serialReadThreshold: 3,
        longTailStepThreshold: 6,
        stallStepsThreshold: 4,
        cooldownSteps: 3
      }
    },
    script: [
      [call('r1', 'read', { file_path: 'a.js' }), call('r2', 'read', { file_path: 'b.js' })],
      [call('e1', 'edit', { file_path: 'a.js', old_string: 'a = 1', new_string: 'a = 2' })],
      [call('t1', 'bash', { command: 'echo ok-1' })],
      [call('r3', 'read', { file_path: 'a.js' }), call('r4', 'read', { file_path: 'b.js' })],
      [call('e2', 'edit', { file_path: 'b.js', old_string: 'b = 1', new_string: 'b = 2' })],
      [call('t2', 'bash', { command: 'echo ok-2' })],
      [call('r5', 'read', { file_path: 'a.js' }), call('r6', 'read', { file_path: 'b.js' })],
      [call('t3', 'bash', { command: 'echo ok-3' })],
      [{ type: 'text', text: 'Completed healthy refactor.' }]
    ]
  });

  try {
    await activeHost.run('Refactor and verify');
    assert.equal(activeHost.errors.length, 0);
    assert.equal(findConvergenceEvents(activeHost.events).length, 0);
    assert.equal(activeHost.ctx.get('convergenceGuidance').getSummary(activeHost.agent.session).reminded, false);
  } finally {
    await activeHost.dispose();
  }

  // 3. Healthy high-parallel read-only audit stretches long-tail threshold 2x (silent through step 11, nudges at step 12)
  const parallelFiles = { 'f1.txt': '1', 'f2.txt': '2' };
  const parallelSteps = Array.from({ length: 12 }, (_, idx) => [
    call(`p${idx}a`, 'read', { file_path: 'f1.txt' }),
    call(`p${idx}b`, 'read', { file_path: 'f2.txt' })
  ]);
  const parallelHost = await createTestRuntime({
    files: parallelFiles,
    optimizerConfig: {
      convergence: {
        enabled: true,
        serialReadThreshold: 3,
        longTailStepThreshold: 6,
        stallStepsThreshold: 3,
        cooldownSteps: 3
      }
    },
    script: [
      ...parallelSteps,
      [{ type: 'text', text: 'Audit complete.' }]
    ]
  });

  try {
    await parallelHost.run('Run parallel audit across files');
    assert.equal(parallelHost.errors.length, 0);
    const reminders = findConvergenceEvents(parallelHost.events);
    assert.equal(reminders.length, 1);
    // Stretched 2x: longTailStepThreshold(6)*2 = 12, stallStepsThreshold(3)*2 = 6 -> fires only at step 12
    assert.deepEqual(findReminderTriggerSteps(parallelHost.requests), [12]);
    assert.equal(reminders[0].data.source.signal, 'long-tail-stall');
  } finally {
    await parallelHost.dispose();
  }
});

test('periodic convergence respects softStepBudget, suppresses only the step after top-level error, and prevents post-error bursts', async () => {
  // 1. Legacy periodic mode with softStepBudget
  const budgetHost = await createTestRuntime({
    optimizerConfig: {
      convergence: {
        enabled: true,
        mode: 'periodic',
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
    await budgetHost.run('Inspect README.md thoroughly');
    assert.equal(budgetHost.errors.length, 0);
    assert.equal(budgetHost.requests.length, 4);
    const reminders = findConvergenceEvents(budgetHost.events);
    assert.equal(reminders.length, 2);
    assert.deepEqual(findReminderTriggerSteps(budgetHost.requests), [2, 4]);
    assert.equal(reminders[0].data.content[0].text, REMINDER);
    assert.equal(budgetHost.ctx.get('convergenceGuidance').getSummary(budgetHost.agent.session).signals.periodic, 2);
  } finally {
    await budgetHost.dispose();
  }

  // 2. Error suppression with cooldown prevents burst-after-error ([3, 5], NOT [3, 4])
  const errorHost = await createTestRuntime({
    files: { 'ok.txt': 'all good' },
    optimizerConfig: {
      convergence: {
        enabled: true,
        mode: 'periodic',
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
      // Step 1: top-level tool fails
      [call('c1', 'read', { file_path: 'error.txt' })],
      // Step 2: suppressed by Step 1 error
      [call('c2', 'read', { file_path: 'ok.txt' })],
      // Step 3: Step 2 clean -> reminder #1 injected (lastReminderStep = 3)
      [call('c3', 'read', { file_path: 'ok.txt' })],
      // Step 4: suppressed by cooldown (next due = 3 + 2 = 5, no burst!)
      [call('c4', 'read', { file_path: 'ok.txt' })],
      // Step 5: cooldown elapsed -> reminder #2 injected (lastReminderStep = 5)
      [call('c5', 'read', { file_path: 'ok.txt' })],
      // Step 6: capped at maxRemindersPerTurn = 2
      [call('c6', 'read', { file_path: 'ok.txt' })],
      [{ type: 'text', text: 'Concluded task.' }]
    ]
  });

  try {
    await errorHost.run('Run periodic task with error recovery');
    assert.equal(errorHost.errors.length, 0);
    const reminders = findConvergenceEvents(errorHost.events);
    assert.equal(reminders.length, 2);
    assert.deepEqual(findReminderTriggerSteps(errorHost.requests), [3, 5]);
    const summary = errorHost.ctx.get('convergenceGuidance').getSummary(errorHost.agent.session);
    assert.equal(summary.remindersSent, 2);
    assert.equal(summary.lastReminderStep, 5);
  } finally {
    await errorHost.dispose();
  }

  // 3. Adaptive mode also suppresses after top-level error and enforces cooldown without bursting
  const adaptiveErrHost = await createTestRuntime({
    files: { 'a.txt': 'a', 'b.txt': 'b' },
    optimizerConfig: {
      customPrompt: { enabled: false },
      convergence: {
        enabled: true,
        serialReadThreshold: 2,
        cooldownSteps: 3,
        longTailStepThreshold: 20,
        maxRemindersPerTurn: 2
      }
    },
    readHandler(args) {
      if (args.file_path === 'missing.txt') throw new Error('ENOENT');
      return 'ok';
    },
    script: [
      [call('ae1', 'read', { file_path: 'a.txt' })],
      [call('ae2', 'read', { file_path: 'b.txt' })],
      // Step 3: 2 consecutive serial reads -> serial-exploration #1, then step 3 itself fails
      [call('ae3', 'read', { file_path: 'missing.txt' })],
      // Step 4: suppressed by step 3 error + cooldown (3 + 3 = 6)
      [call('ae4', 'read', { file_path: 'a.txt' })],
      // Step 5: suppressed by cooldown
      [call('ae5', 'read', { file_path: 'b.txt' })],
      // Step 6: cooldown elapsed -> serial-exploration #2
      [{ type: 'text', text: 'Recovered and done.' }]
    ]
  });

  try {
    await adaptiveErrHost.run('Adaptive error recovery');
    assert.equal(adaptiveErrHost.errors.length, 0);
    assert.deepEqual(findReminderTriggerSteps(adaptiveErrHost.requests), [3, 6]);
  } finally {
    await adaptiveErrHost.dispose();
  }
});

test('convergence ignores child sub-call failures inside composite tools and reconstructs full turn state from snapshotEvents()', async () => {
  // Partial child grep failure inside find_and_read (top-level succeeds) must not set stepHasError
  let grepCalls = 0;
  const host = await createTestRuntime({
    files: { 'app.js': 'export const ok = 1;\n' },
    optimizerConfig: {
      convergence: {
        enabled: true,
        mode: 'periodic',
        stepInterval: 2,
        maxRemindersPerTurn: 2
      }
    },
    grepHandler(args) {
      grepCalls++;
      if (args.pattern === 'broken-subpattern') {
        throw new Error('simulated child grep failure');
      }
      return 'app.js:1:export const ok = 1;';
    },
    script: [
      [call('fr1', 'find_and_read', { patterns: ['ok', 'broken-subpattern'] })],
      // Step 2: top-level find_and_read succeeded -> reminder must NOT be suppressed by child grep failure
      [{ type: 'text', text: 'Finished despite child failure.' }]
    ]
  });

  try {
    await host.run('Search with partial child failure');
    assert.equal(host.errors.length, 0);
    assert.equal(grepCalls, 2);
    const reminders = findConvergenceEvents(host.events);
    assert.equal(reminders.length, 1);
    assert.deepEqual(findReminderTriggerSteps(host.requests), [2]);
  } finally {
    await host.dispose();
  }

  // Replay fidelity from snapshotEvents() across multiple turns (cross-turn isolated)
  const fakeCtx = { on() {} };
  const replayed = applyConvergence(fakeCtx, { enabled: true, serialReadThreshold: 3 });
  const fakeSession = {
    snapshotEvents() {
      return [
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
        { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read' } },
        { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: { callId: 'c1', isError: false } } },
        { seq: 5, type: 'step/end', data: { turn: 1, step: 1 } },
        { seq: 6, type: 'step/start', data: { turn: 1, step: 2 } },
        { seq: 7, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'grep' } },
        { seq: 8, type: 'tool/result', data: { turn: 1, step: 2, message: { callId: 'c2', isError: false } } },
        { seq: 9, type: 'step/end', data: { turn: 1, step: 2 } },
        { seq: 10, type: 'step/start', data: { turn: 1, step: 3 } },
        {
          seq: 11,
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: '[Step 3: notice]' }],
            source: { kind: CONVERGENCE_SOURCE, form: 'notice', summary: 's', signal: 'serial-exploration' }
          }
        },
        { seq: 12, type: 'turn/end', data: { turn: 1 } },
        // Turn 2 reminder must NOT leak into Turn 1 summary
        { seq: 13, type: 'turn/start', data: { turn: 2 } },
        { seq: 14, type: 'step/start', data: { turn: 2, step: 1 } },
        {
          seq: 15,
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: REMINDER }],
            source: { kind: CONVERGENCE_SOURCE, form: 'notice', summary: 's', signal: 'periodic' }
          }
        }
      ];
    }
  };
  const turn1 = replayed.getSummary(fakeSession, 1);
  assert.equal(turn1.steps, 3);
  assert.equal(turn1.remindersSent, 1);
  assert.equal(turn1.lastReminderStep, 3);
  assert.equal(turn1.lastSignal, 'serial-exploration');
  assert.equal(turn1.signals['serial-exploration'], 1);
  assert.equal(turn1.signals.periodic, 0);
  assert.equal(turn1.reminderCharsAdded, '[Step 3: notice]'.length);
  assert.equal(turn1.consecutiveSerialReads, 2);
  assert.equal(turn1.stepsWithoutProgress, 2);

  // buildGuidance trims tool references cleanly
  const trimmed = buildGuidance({ hasFindAndRead: false, hasEditBatch: false });
  assert.doesNotMatch(trimmed, /find_and_read|edit_batch|npm publish/);
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
    optimizerConfig: { persistentEval: { enabled: true } },
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

test('failureRecovery isolates in-flight candidates across concurrent sessions', async () => {
  const { applyFailureRecovery, PAIRING_ERROR } = await import('../src/failure-recovery.js');
  const listeners = new Map();
  const writeDef = { name: 'write' };
  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    tools: {
      register() {},
      get: name => (name === 'write' ? writeDef : undefined),
      executable: name => (name === 'write' ? writeDef : undefined)
    }
  };
  const service = applyFailureRecovery(ctx, { enabled: true });
  const sessionA = { id: 'sess-a' };
  const sessionB = { id: 'sess-b' };
  const agentB = { session: sessionB };
  const emitSession = (session, event) => {
    for (const fn of listeners.get('session/event') ?? []) fn(session, event);
  };

  emitSession(sessionA, { type: 'turn/start', data: { turn: 1 } });
  emitSession(sessionB, { type: 'turn/start', data: { turn: 1 } });

  const execB = {
    token: Symbol('exec-b'),
    callId: 'write-b',
    rootCallId: 'write-b',
    parent: undefined,
    name: 'write',
    agent: agentB,
    signal: new AbortController().signal,
    arguments: {
      file_path: 'out.txt',
      content: 'Z'.repeat(9000),
      justification: 'Unpaired justification'
    }
  };
  const errResult = { isError: true, error: { message: PAIRING_ERROR } };

  for (const fn of listeners.get('tools/execute') ?? []) {
    await fn(execB, async () => errResult);
  }
  // Session A finishes turn while Session B is between tools/execute and tools/result
  emitSession(sessionA, { type: 'turn/end', data: { turn: 1 } });

  for (const fn of listeners.get('tools/result') ?? []) {
    fn(execB, errResult);
  }

  const recordB = service.getRecord(sessionB);
  assert.ok(recordB, 'Session A turn/end must not clear Session B in-flight candidate');
  assert.equal(recordB.callId, 'write-b');
});

test('fileMutationPolicy handles null stat, toolSet edit admission, and edit_batch/find_and_read without double-counting', async () => {
  const { fileExists, FileMutationPolicyManager } = await import('../src/file-mutation-policy.js');
  const nullStatFs = {
    async resolve(filePath) { return { targetKey: filePath }; },
    async stat() { return null; }
  };
  assert.equal(await fileExists('absent.ts', '', nullStatFs), false);

  const manager = new FileMutationPolicyManager({ mode: 'enforce', minLargeWriteBytes: 32 });
  const session = { id: 'mutation-toolset' };
  manager.onTurnStart(session, 1);

  // Direct edit_batch & find_and_read recording when leaf sub-calls were not emitted
  manager.recordResult(session, {
    token: Symbol('direct-batch'),
    name: 'edit_batch',
    arguments: { edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }] }
  }, { isError: false });
  manager.recordResult(session, {
    name: 'find_and_read',
    arguments: { path: 'src' }
  }, { isError: false });
  let summary = manager.getSummary(session, 1);
  assert.equal(summary.editsCount, 2);
  assert.equal(summary.observedFiles, 3);

  // Pipeline edit_batch where leaf 'edit' sub-calls already ran must NOT double-count
  const batchToken = Symbol('pipeline-batch');
  manager.recordResult(session, {
    parent: batchToken,
    name: 'edit',
    arguments: { file_path: 'c.ts' }
  }, { isError: false });
  manager.recordResult(session, {
    token: batchToken,
    name: 'edit_batch',
    arguments: { edits: [{ file_path: 'c.ts' }, { file_path: 'd.ts' }] }
  }, { isError: false });
  summary = manager.getSummary(session, 1);
  assert.equal(summary.editsCount, 3);

  // Respect exec.toolSet when checking whether 'edit' is admitted
  const restrictedToolSet = new Set(['write']);
  const toolsService = {
    get(name, _agent, toolSet) {
      if (toolSet) return toolSet.has(name) ? { name } : undefined;
      return { name };
    }
  };
  const decision = await manager.evaluateToolExecution(session, {
    callId: 'w-large',
    name: 'write',
    agent: { session },
    toolSet: restrictedToolSet,
    arguments: { file_path: 'a.ts', content: 'X'.repeat(100) }
  }, toolsService, nullStatFs);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'no-edit-available');
});

