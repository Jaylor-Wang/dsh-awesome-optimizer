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

test('edit_batch skips subsequent same-file edits after a runtime failure when preflight cannot read file', async () => {
  const host = await createTestRuntime({
    files: {
      'virtual-only.txt': 'keep me intact\nsecond line'
    },
    script: [
      [call('eb-failfast', 'edit_batch', {
        edits: [
          { file_path: 'virtual-only.txt', old_string: 'missing-first', new_string: 'nope' },
          { file_path: 'virtual-only.txt', old_string: 'keep me intact', new_string: 'mutated' }
        ]
      })],
      [{ type: 'text', text: 'Fail-fast verified.' }]
    ]
  });

  try {
    await host.run('Fail-fast same-file edit test');
    assert.equal(host.virtualFs.get('virtual-only.txt'), 'keep me intact\nsecond line');
    assert.equal(host.calls.filter(c => c.name === 'edit').length, 1);
    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults[0].data.message.isError, true);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /Skipped edit #2 after an earlier failure/);
  } finally {
    await host.dispose();
  }
});
