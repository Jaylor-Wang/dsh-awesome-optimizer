import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeMatchWindows, parseGrepOutput } from '../src/index.js';
import { createTestRuntime, call } from './support/runtime.js';

test('find_and_read searches multiple patterns, merges nearby windows, and observes read files in one round-trip', async () => {
  const authLines = [
    '// auth header',
    ...Array.from({ length: 12 }, (_, i) => `const authPad${i} = ${i};`),
    'export function verifyToken(token) {',
    '  return token.startsWith("dsh_");',
    '}',
    'const afterVerify = 1;',
    'export function refreshToken(token) {',
    '  return verifyToken(token);',
    '}',
    ...Array.from({ length: 10 }, (_, i) => `const authTail${i} = ${i};`)
  ];
  const testLines = [
    'import { verifyToken } from "./auth.js";',
    ...Array.from({ length: 15 }, (_, i) => `const testPad${i} = ${i};`),
    'assert.equal(verifyToken("dsh_1"), true);'
  ];

  const host = await createTestRuntime({
    files: {
      'src/auth.js': authLines.join('\n'),
      'test/auth.test.js': testLines.join('\n')
    },
    script: [
      [call('fr1', 'find_and_read', {
        patterns: ['verifyToken', 'refreshToken'],
        contextLines: 2
      })],
      [{ type: 'text', text: 'Located both definitions and test call site.' }]
    ]
  });

  try {
    await host.run('Find verifyToken and refreshToken');
    assert.equal(host.errors.length, 0);
    assert.equal(host.requests.length, 2);

    // 2 parallel grep calls + merged read calls
    assert.equal(host.calls.filter(c => c.name === 'grep').length, 2);
    // verifyToken (14, 19) and refreshToken (18) in auth.js overlap within contextLines=2 -> merged into 1 window!
    // test/auth.test.js has lines 1 and 17 -> 2 windows. Total = 3 merged reads!
    assert.equal(host.calls.filter(c => c.name === 'read').length, 3);

    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].data.message.isError, false);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /=== src\/auth\.js:12-21 ===/);
    assert.match(output, /> 14: export function verifyToken/);
    assert.match(output, /> 18: export function refreshToken/);

    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.findExecuted, 1);
    assert.equal(stats.findPatternsSearched, 2);
    assert.equal(stats.findFilesMatched, 2);
    assert.equal(stats.findWindowsRead, 3);

    // FileMutationPolicy recorded both files via leaf read pipeline calls
    const mutationSummary = host.fileMutationPolicy.getSummary(host.agent.session);
    assert.equal(mutationSummary.observedFiles, 2);
  } finally {
    await host.dispose();
  }
});

test('find_and_read enforces maxFiles/maxTotalBytes with overflow index and supports contextLines=0 & zero-match non-error', async () => {
  const longLine = 'X'.repeat(400);
  const host = await createTestRuntime({
    optimizerConfig: {
      compositeTools: {
        enabled: true,
        maxLineChars: 100,
        maxTotalBytes: 512,
        maxFiles: 2,
        maxWindows: 4
      }
    },
    files: {
      'a.ts': `targetMatch ${longLine}`,
      'b.ts': 'targetMatch in b\nline 2',
      'c.ts': 'targetMatch in c\nline 2'
    },
    script: [
      [call('fr-budget', 'find_and_read', { pattern: 'targetMatch', contextLines: 1 })],
      [call('fr-index', 'find_and_read', { pattern: 'targetMatch', contextLines: 0 })],
      [call('fr-none', 'find_and_read', { pattern: 'definitelyNotPresentAnywhere' })],
      [{ type: 'text', text: 'Verified budget, index mode, and zero-match.' }]
    ]
  });

  try {
    await host.run('Check find_and_read modes');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 3);
    assert.equal(results[0].data.message.isError, false);
    assert.equal(results[1].data.message.isError, false);
    assert.equal(results[2].data.message.isError, false);

    const outBudget = results[0].data.message.content.map(b => b.text).join('\n');
    assert.match(outBudget, /\[line truncated:/);
    assert.match(outBudget, /--- Additional matches \(index only\) ---/);
    assert.match(outBudget, /c\.ts: L1/);

    const outIndex = results[1].data.message.content.map(b => b.text).join('\n');
    assert.match(outIndex, /=== a\.ts \(1 matches\) ===/);
    // contextLines=0 did not dispatch extra read calls
    assert.equal(host.calls.filter(c => c.name === 'read').length, 2);

    const outNone = results[2].data.message.content.map(b => b.text).join('\n');
    assert.match(outNone, /No matches found for pattern\(s\): definitelyNotPresentAnywhere/);
  } finally {
    await host.dispose();
  }
});

test('parseGrepOutput handles DSH grouped format, ripgrep Windows paths, and mergeMatchWindows merges adjacent lines', () => {
  const grouped = [
    'Found 2 matches',
    '',
    'src/policy.js',
    'Line 10: export function check() {}',
    'Line 14: return check();'
  ].join('\n');
  assert.deepEqual(parseGrepOutput(grouped), [
    { path: 'src/policy.js', lineNumber: 10, line: 'export function check() {}' },
    { path: 'src/policy.js', lineNumber: 14, line: 'return check();' }
  ]);

  const winFlat = 'C:\\repo\\src\\app.ts:42:const port = 3000;\n';
  assert.deepEqual(parseGrepOutput(winFlat), [
    { path: 'C:\\repo\\src\\app.ts', lineNumber: 42, line: 'const port = 3000;' }
  ]);

  assert.deepEqual(mergeMatchWindows([10, 14, 50], 3, 2), [
    { start: 7, end: 17, matchedLines: [10, 14] },
    { start: 47, end: 53, matchedLines: [50] }
  ]);

  // Windows backslash vs POSIX slash paths must deduplicate cleanly when merging meta + rendered text
  const mixedDedup = parseGrepOutput(
    'src\\policy.js:10:export function check() {}\n',
    { matches: [{ path: 'src/policy.js', lineNumber: 10, line: 'export function check() {}' }] }
  );
  assert.equal(mixedDedup.length, 1);
});

test('edit_batch edits multiple files in a single tool call through ToolExecutionPipeline', async () => {
  const host = await createTestRuntime({
    files: {
      'src/file1.ts': 'export const one = 1;',
      'src/file2.ts': 'export const two = 2;'
    },
    script: [
      [call('eb1', 'edit_batch', {
        edits: [
          { file_path: 'src/file1.ts', old_string: '1', new_string: '100' },
          { file_path: 'src/file2.ts', old_string: '2', new_string: '200' }
        ]
      })],
      [{ type: 'text', text: 'Batch edits applied across both files.' }]
    ]
  });

  try {
    await host.run('Edit file1 and file2 in one turn');
    assert.equal(host.errors.length, 0);
    assert.equal(host.requests.length, 2);

    // Underlying native edit tool was invoked twice via ToolExecutionPipeline
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 2);
    assert.equal(host.virtualFs.get('src/file1.ts'), 'export const one = 100;');
    assert.equal(host.virtualFs.get('src/file2.ts'), 'export const two = 200;');

    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.editBatchesExecuted, 1);
    assert.equal(stats.editsRequested, 2);
    assert.equal(stats.editsSucceeded, 2);
    assert.equal(stats.editsFailed, 0);
  } finally {
    await host.dispose();
  }
});

test('edit_batch applies sequential edits to the same file in order', async () => {
  const host = await createTestRuntime({
    files: {
      'doc.txt': 'first-word second-word third-word'
    },
    script: [
      [call('eb-seq', 'edit_batch', {
        edits: [
          { file_path: 'doc.txt', old_string: 'first-word', new_string: 'alpha' },
          { file_path: 'doc.txt', old_string: 'second-word', new_string: 'beta' }
        ]
      })],
      [{ type: 'text', text: 'Sequential edits applied in order.' }]
    ]
  });

  try {
    await host.run('Edit doc.txt sequentially');
    assert.equal(host.errors.length, 0);
    assert.equal(host.virtualFs.get('doc.txt'), 'alpha beta third-word');
    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.editsSucceeded, 2);
  } finally {
    await host.dispose();
  }
});

test('edit_batch tolerates partial failures without losing successful edits', async () => {
  const host = await createTestRuntime({
    files: {
      'valid.txt': 'preserve this key: old-val',
      'unmatched.txt': 'different text'
    },
    script: [
      [call('eb-partial', 'edit_batch', {
        edits: [
          { file_path: 'valid.txt', old_string: 'old-val', new_string: 'new-val' },
          { file_path: 'unmatched.txt', old_string: 'non-existent', new_string: 'replacement' }
        ]
      })],
      [{ type: 'text', text: 'Handled partial edit batch.' }]
    ]
  });

  try {
    await host.run('Perform mixed edit batch');
    assert.equal(host.errors.length, 0);
    assert.equal(host.virtualFs.get('valid.txt'), 'preserve this key: new-val');

    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.editsSucceeded, 1);
    assert.equal(stats.editsFailed, 1);

    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].data.message.isError, false);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /^\[PARTIAL\].*1\/2 edits succeeded/);
    assert.match(output, /Edited valid\.txt/);
    assert.match(output, /\[ERROR\]/);
  } finally {
    await host.dispose();
  }
});

test('find_and_read strips DSH <content> envelope when rendering slices', async () => {
  const host = await createTestRuntime({
    files: {
      'wrapped.ts': 'line 1\nconst needle = true;\nline 3'
    },
    readHandler(args) {
      return [
        `<path>${args.file_path}</path>`,
        '<type>file</type>',
        '<content>',
        '1: line 1',
        '2: const needle = true;',
        '3: line 3',
        '',
        '(End of file - total 3 lines)',
        '</content>'
      ].join('\n');
    },
    script: [
      [call('fr-env', 'find_and_read', { pattern: 'needle', contextLines: 1 })],
      [{ type: 'text', text: 'Stripped envelope cleanly.' }]
    ]
  });

  try {
    await host.run('Strip envelope');
    const results = host.events.filter(e => e.type === 'tool/result');
    const output = results[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /> 2: const needle = true;/);
    assert.doesNotMatch(output, /<content>/);
    assert.doesNotMatch(output, /End of file/);
  } finally {
    await host.dispose();
  }
});

test('edit_batch pre-flights same-file multi-edits on disk and prevents partial file corruption', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-preflight-'));
  const targetFile = path.join(tempDir, 'target.txt');
  const otherFile = path.join(tempDir, 'other.txt');
  fs.writeFileSync(targetFile, 'alpha beta gamma', 'utf8');
  fs.writeFileSync(otherFile, 'hello world', 'utf8');

  const host = await createTestRuntime({
    editHandler(args) {
      const raw = fs.readFileSync(args.file_path, 'utf8');
      if (!raw.includes(args.old_string)) throw new Error('old_string not found');
      fs.writeFileSync(args.file_path, raw.replace(args.old_string, args.new_string), 'utf8');
      return `Edited ${args.file_path}`;
    },
    configureTools(ctx) {
      ctx.get('fs').readFile = async filePath => fs.readFileSync(filePath, 'utf8');
    },
    script: [
      [call('eb-preflight', 'edit_batch', {
        edits: [
          { file_path: targetFile, old_string: 'alpha', new_string: 'ALPHA' },
          { file_path: targetFile, old_string: 'non-existent-second-hunk', new_string: 'BETA' },
          { file_path: otherFile, old_string: 'world', new_string: 'DSH' }
        ]
      })],
      [{ type: 'text', text: 'Pre-flight protected target.txt while updating other.txt.' }]
    ]
  });

  try {
    await host.run('Edit batch with same-file preflight protection');
    // targetFile must remain completely untouched because hunk #2 failed pre-flight
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'alpha beta gamma');
    // Independent valid file still succeeded
    assert.equal(fs.readFileSync(otherFile, 'utf8'), 'hello DSH');
    // Zero edit dispatches were sent for targetFile
    const targetEditCalls = host.calls.filter(c => c.name === 'edit' && c.args.file_path === targetFile);
    assert.equal(targetEditCalls.length, 0);

    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.editsSucceeded, 1);
    assert.equal(stats.editsFailed, 2);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('edit_batch atomic=true aborts entire cross-file batch on pre-flight failure without any writes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-atomic-'));
  const fileA = path.join(tempDir, 'a.txt');
  const fileB = path.join(tempDir, 'b.txt');
  fs.writeFileSync(fileA, 'foo = 1', 'utf8');
  fs.writeFileSync(fileB, 'bar = 2', 'utf8');

  const host = await createTestRuntime({
    editHandler(args) {
      const raw = fs.readFileSync(args.file_path, 'utf8');
      if (!raw.includes(args.old_string)) throw new Error('old_string not found');
      fs.writeFileSync(args.file_path, raw.replace(args.old_string, args.new_string), 'utf8');
      return `Edited ${args.file_path}`;
    },
    configureTools(ctx) {
      ctx.get('fs').readFile = async filePath => fs.readFileSync(filePath, 'utf8');
    },
    script: [
      [call('eb-atomic', 'edit_batch', {
        atomic: true,
        edits: [
          { file_path: fileA, old_string: 'foo = 1', new_string: 'foo = 99' },
          { file_path: fileB, old_string: 'missing = 0', new_string: 'bar = 99' }
        ]
      })],
      [{ type: 'text', text: 'Atomic batch aborted cleanly.' }]
    ]
  });

  try {
    await host.run('Atomic edit_batch test');
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'foo = 1');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'bar = 2');
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 0);

    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults[0].data.message.isError, true);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /Atomic edit_batch aborted/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('strict edit_batch aborts before dispatch when preflight cannot verify a target', async t => {
  for (const mode of ['denied', 'no-reader', 'no-identity', 'escalation', 'unpaired-justification']) {
    await t.test(mode, async () => {
      const host = await createTestRuntime({
        files: { 'a.txt': 'alpha', 'b.txt': 'beta' },
        configureTools(ctx) {
          const fsService = ctx.get('fs');
          if (mode === 'no-identity') fsService.resolve = async () => ({});
          if (mode !== 'no-reader') {
            fsService.readFile = async filePath => {
              if (mode === 'denied' && filePath === 'b.txt') throw Object.assign(new Error('Read denied'), { code: 'EACCES' });
              return filePath === 'a.txt' ? 'alpha' : 'beta';
            };
          }
        },
        script: [[call('strict', 'edit_batch', { atomic: true, edits: [
          { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
          { file_path: 'b.txt', old_string: 'beta', new_string: 'BETA',
            ...(mode === 'escalation' ? { sandbox_permissions: 'workspace-write' } : {}),
            ...(['escalation', 'unpaired-justification'].includes(mode) ? { justification: 'Request access' } : {}) }
        ] })], [{ type: 'text', text: 'Done.' }]]
      });
      try {
        await host.run('Check that unverifiable targets stop strict batches');
        assert.equal(host.calls.filter(c => c.name === 'edit').length, 0);
        assert.equal(host.virtualFs.get('a.txt'), 'alpha');
        assert.equal(host.virtualFs.get('b.txt'), 'beta');
        const result = host.events.find(e => e.type === 'tool/result').data.message;
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Atomic edit_batch aborted/);
      } finally { await host.dispose(); }
    });
  }
});

test('strict edit_batch simulates host aliases, CRLF, and literal replacement text together', async () => {
  const host = await createTestRuntime({
    files: { 'actual.txt': 'one\ntwo' },
    configureTools(ctx) {
      const fsService = ctx.get('fs');
      fsService.resolve = async displayPath => ({ displayPath, targetKey: 'actual.txt' });
      fsService.readText = async () => 'one\r\ntwo';
    },
    editHandler({ old_string, new_string }, _exec, files) {
      const source = files.get('actual.txt');
      const old = old_string.replaceAll('\r\n', '\n');
      assert.ok(source.includes(old));
      files.set('actual.txt', source.split(old).join(new_string));
      return 'Edited actual.txt';
    },
    script: [[call('alias', 'edit_batch', { atomic: true, edits: [
      { file_path: 'actual.txt', old_string: 'one\r\ntwo', new_string: '$&' },
      { file_path: 'alias.txt', old_string: '$&', new_string: 'done' }
    ] })], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Edit the same filesystem identity using two aliases');
    assert.equal(host.virtualFs.get('actual.txt'), 'done');
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 2);
    assert.equal(host.events.find(e => e.type === 'tool/result').data.message.isError, false);
  } finally { await host.dispose(); }
});

test('strict edit_batch stops on a native execution failure and reports changes already applied', async () => {
  const errors = [];
  const host = await createTestRuntime({
    files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
    configureTools(ctx) {
      ctx.get('fs').readFile = async filePath => filePath[0];
      ctx.on('tools/result', (exec, result) => {
        if (exec.name === 'edit_batch' && result.isError) errors.push(result.error?.info?.code);
      });
    },
    editHandler(args, _exec, files) {
      if (args.file_path === 'b.txt') throw new Error('Native edit denied at dispatch');
      files.set(args.file_path, args.new_string);
      return `Edited ${args.file_path}`;
    },
    script: [[call('strict-partial', 'edit_batch', { atomic: true, edits: ['a', 'b', 'c'].map(letter => ({
      file_path: `${letter}.txt`, old_string: letter, new_string: letter.toUpperCase()
    })) })], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Stop after the first dispatch failure');
    assert.deepEqual(host.calls.filter(c => c.name === 'edit').map(c => c.args.file_path), ['a.txt', 'b.txt']);
    assert.deepEqual([...host.virtualFs.values()], ['A', 'b', 'c']);
    const result = host.events.find(e => e.type === 'tool/result').data.message;
    assert.equal(result.isError, true);
    const output = result.content.map(block => block.text).join('\n');
    assert.match(output, /\[PARTIAL\].*1\/3 edits succeeded/);
    assert.match(output, /Skipped edit #3/);
    assert.deepEqual(errors, ['EDIT_BATCH_PARTIAL']);
    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.editsSucceeded, 1);
    assert.equal(stats.editsFailed, 2);
  } finally { await host.dispose(); }
});

test('strict edit_batch preserves the confirmed partial result when cancelled between edits', async () => {
  const controller = new AbortController();
  const host = await createTestRuntime({
    files: { 'a.txt': 'a', 'b.txt': 'b' },
    configureTools(ctx) {
      ctx.get('fs').readFile = async filePath => filePath[0];
      ctx.on('tools/result', (exec, result) => {
        if (exec.name === 'edit' && !result.isError) controller.abort();
      });
    }
  });
  try {
    const editBatch = host.ctx.tools.get('edit_batch', host.agent);
    await assert.rejects(editBatch.execute({ atomic: true, edits: ['a', 'b'].map(letter => ({
      file_path: `${letter}.txt`, old_string: letter, new_string: letter.toUpperCase()
    })) }, {
      agent: host.agent, callId: 'cancel', rootCallId: 'cancel', signal: controller.signal, deferContext() {}
    }), error => error.code === 'EDIT_BATCH_PARTIAL' && /Skipped edit #2: batch cancelled/.test(error.message));
    assert.deepEqual([...host.virtualFs.values()], ['A', 'b']);
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 1);
  } finally { await host.dispose(); }
});

test('edit_batch skips subsequent same-file edits after a sandbox-denied preflight', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-denied-preflight-'));
  const targetFile = path.join(tempDir, 'target.txt');
  const content = 'keep me intact\nsecond line';
  fs.writeFileSync(targetFile, content, 'utf8');
  const host = await createTestRuntime({
    files: { [targetFile]: content },
    configureTools(ctx) {
      ctx.get('fs').readFile = async () => {
        throw Object.assign(new Error('sandbox denied preflight read'), { code: 'EACCES' });
      };
    },
    script: [
      [call('eb-failfast', 'edit_batch', {
        edits: [
          { file_path: targetFile, old_string: 'missing-first', new_string: 'nope' },
          { file_path: targetFile, old_string: 'keep me intact', new_string: 'mutated' }
        ]
      })],
      [{ type: 'text', text: 'Fail-fast verified.' }]
    ]
  });

  try {
    await host.run('Fail-fast same-file edit test');
    assert.equal(host.virtualFs.get(targetFile), content);
    // The denied fs service must not fall back to the local target file. The first
    // edit reaches the native pipeline and fails; the second is then skipped.
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 1);
    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults[0].data.message.isError, true);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /Skipped edit #2 after an earlier failure/);

    const controller = new AbortController();
    const fsService = host.ctx.get('fs');
    fsService.readFile = async (_filePath, { signal }) => {
      controller.abort(new Error('workspace cancellation'));
      signal?.throwIfAborted();
      throw new Error('workspace cancellation');
    };
    const editBatch = host.ctx.tools.get('edit_batch', host.agent);
    const editCallsBeforeCancellation = host.calls.filter(call => call.name === 'edit').length;
    await assert.rejects(editBatch.execute({
      edits: [
        { file_path: targetFile, old_string: 'keep me intact', new_string: 'cancelled' },
        { file_path: targetFile, old_string: 'second line', new_string: 'also cancelled' }
      ]
    }, {
      agent: host.agent,
      callId: 'eb-cancelled',
      rootCallId: 'eb-cancelled',
      signal: controller.signal,
      deferContext() {}
    }), /abort|cancellation/i);
    assert.equal(host.calls.filter(call => call.name === 'edit').length, editCallsBeforeCancellation);
    assert.equal(host.virtualFs.get(targetFile), content);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('edit_batch preflight enforces maxPreflightBytes via stat before reading and never bypasses unavailable fs', async () => {
  let readCalls = 0;
  const host = await createTestRuntime({
    files: { 'huge.ts': 'x'.repeat(8000) },
    optimizerConfig: {
      compositeTools: { maxPreflightBytes: 4096 }
    },
    configureTools(ctx) {
      const fsService = ctx.get('fs');
      fsService.readBytes = async () => { readCalls++; return Buffer.from('should not read'); };
      fsService.readFile = async () => { readCalls++; return 'should not read'; };
    },
    script: [
      [call('eb-oversized-atomic', 'edit_batch', {
        atomic: true,
        edits: [{ file_path: 'huge.ts', old_string: 'x', new_string: 'y' }]
      })],
      [call('eb-oversized-best-effort', 'edit_batch', {
        atomic: false,
        edits: [
          { file_path: 'huge.ts', old_string: 'xxxx', new_string: 'YYYY' },
          { file_path: 'huge.ts', old_string: 'YYYY', new_string: 'ZZZZ' }
        ]
      })],
      [{ type: 'text', text: 'Oversized preflight handled.' }]
    ]
  });

  try {
    await host.run('Verify edit_batch stat size preflight');
    // Neither atomic nor non-atomic preflight should read file content after stat reports size > maxPreflightBytes
    assert.equal(readCalls, 0);
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 2);
    // Atomic mode aborts cleanly without dispatching edits
    assert.equal(results[0].data.message.isError, true);
    assert.match(results[0].data.message.content[0].text, /maxPreflightBytes/);
    // Non-atomic mode skips preflight simulation and lets native edit proceed
    assert.equal(results[1].data.message.isError, false);
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 2);
  } finally {
    await host.dispose();
  }
});

test('edit_batch non-atomic preflight normalizes CRLF and reports multiple-matches accurately', async () => {
  const host = await createTestRuntime({
    files: {
      'crlf.ts': 'const a = 1;\r\nconst b = 2;\r\nconst dup = 1;\r\nconst dup = 1;\r\n'
    },
    configureTools(ctx, { virtualFs }) {
      ctx.get('fs').readFile = async filePath => virtualFs.get(filePath);
    },
    editHandler(args, _exec, virtualFs) {
      const normalized = virtualFs.get(args.file_path).replaceAll('\r\n', '\n');
      const old = args.old_string.replaceAll('\r\n', '\n');
      if (!normalized.includes(old)) throw new Error('old_string not found');
      virtualFs.set(args.file_path, normalized.replace(old, args.new_string).replaceAll('\n', '\r\n'));
      return `Edited ${args.file_path}`;
    },
    script: [
      // Multi-edit with LF old_string against CRLF disk content should pass non-atomic preflight
      [call('eb-crlf-ok', 'edit_batch', {
        edits: [
          { file_path: 'crlf.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;\nconst b = 20;' },
          { file_path: 'crlf.ts', old_string: 'const b = 20;', new_string: 'const b = 30;' }
        ]
      })],
      // Duplicate CRLF old_string should report multiple-matches hint accurately
      [call('eb-crlf-dup', 'edit_batch', {
        atomic: true,
        edits: [
          { file_path: 'crlf.ts', old_string: 'const dup = 1;\r\n', new_string: 'const dup = 2;\r\n' }
        ]
      })],
      [{ type: 'text', text: 'CRLF preflight verified.' }]
    ]
  });

  try {
    await host.run('Verify CRLF preflight');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 2);
    assert.equal(results[0].data.message.isError, false);
    assert.match(host.virtualFs.get('crlf.ts'), /const a = 10;\r\nconst b = 30;/);
    assert.equal(results[1].data.message.isError, true);
    const dupText = results[1].data.message.content.map(b => b.text).join('\n');
    assert.match(dupText, /contains 2 exact matches/);
  } finally {
    await host.dispose();
  }
});

test('find_and_read respects step toolSet read admission and tolerates throwing workingDirectory', async () => {
  const host = await createTestRuntime({
    files: { 'a.ts': 'export const target = 1;\n' },
    script: [
      [call('fr-no-read', 'find_and_read', { pattern: 'target', contextLines: 2 })],
      [{ type: 'text', text: 'Degraded to match listing cleanly.' }]
    ]
  });

  try {
    // Shadow read with a per-agent conditional tool denied in the step toolSet
    host.agent.ctx.tools.register({
      name: 'read',
      description: 'Conditional read denied for this step.',
      parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() { throw new Error('read should not be dispatched'); }
    }, { when: () => false });

    const origGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = name => {
      if (name === 'workingDirectory') throw new Error('cwd service unavailable');
      return origGet(name);
    };

    await host.run('Search when read tool is not admitted in toolSet');
    assert.equal(host.errors.length, 0);
    assert.equal(host.calls.filter(c => c.name === 'read').length, 0);
    const result = host.events.find(e => e.type === 'tool/result').data.message;
    const output = result.content.map(b => b.text).join('\n');
    assert.equal(result.isError, false, `Unexpected tool error: ${output}`);
    assert.match(output, /=== a\.ts \(1 matches\) ===/);
    assert.match(output, /1: export const target = 1;/);
  } finally {
    await host.dispose();
  }
});

test('edit_batch caches resolve failures, preserves resolve denial errors, and groups aliases in non-atomic mode', async () => {
  // 1. Atomic mode caches repeated ENOENT resolves and preserves real EACCES error messages
  const resolveCounts = new Map();
  const strictHost = await createTestRuntime({
    files: {},
    configureTools(ctx) {
      ctx.get('fs').resolve = async filePath => {
        resolveCounts.set(filePath, (resolveCounts.get(filePath) ?? 0) + 1);
        if (filePath === 'missing.ts') {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('sandbox forbids path'), { code: 'EACCES' });
      };
    },
    script: [
      [call('eb-resolve', 'edit_batch', {
        atomic: true,
        edits: [
          { file_path: 'missing.ts', old_string: 'a', new_string: 'b' },
          { file_path: 'missing.ts', old_string: 'c', new_string: 'd' },
          { file_path: 'forbidden.ts', old_string: 'x', new_string: 'y' }
        ]
      })],
      [{ type: 'text', text: 'Handled resolve errors.' }]
    ]
  });

  try {
    await strictHost.run('Verify resolve caching and denial reporting');
    assert.equal(resolveCounts.get('missing.ts'), 1);
    assert.equal(resolveCounts.get('forbidden.ts'), 1);
    const result = strictHost.events.find(e => e.type === 'tool/result').data.message;
    assert.equal(result.isError, true);
    const text = result.content.map(b => b.text).join('\n');
    assert.match(text, /target file does not exist/);
    assert.match(text, /sandbox forbids path \(EACCES\)/);
  } finally {
    await strictHost.dispose();
  }

  // 2. Non-atomic mode groups aliased paths by resolved targetKey to preflight and fail-fast together
  const aliasHost = await createTestRuntime({
    files: { 'real.ts': 'const first = 1;\nconst second = 2;\n' },
    configureTools(ctx, { virtualFs }) {
      const fsService = ctx.get('fs');
      fsService.resolve = async displayPath => ({ displayPath, targetKey: 'real.ts' });
      fsService.readText = async () => virtualFs.get('real.ts');
    },
    script: [
      [call('eb-alias-non-atomic', 'edit_batch', {
        atomic: false,
        edits: [
          { file_path: 'real.ts', old_string: 'first = 1', new_string: 'first = 9' },
          { file_path: 'symlink-to-real.ts', old_string: 'missing_line', new_string: 'nope' }
        ]
      })],
      [{ type: 'text', text: 'Alias preflight protected real.ts.' }]
    ]
  });

  try {
    await aliasHost.run('Verify non-atomic alias grouping');
    assert.equal(aliasHost.calls.filter(c => c.name === 'edit').length, 0);
    assert.equal(aliasHost.virtualFs.get('real.ts'), 'const first = 1;\nconst second = 2;\n');
  } finally {
    await aliasHost.dispose();
  }
});
