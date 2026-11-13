import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';

test('read_batch reads multiple files in a single tool call through ToolExecutionPipeline', async () => {
  const host = await createTestRuntime({
    files: {
      'src/a.js': 'export const a = 1;\nexport const a2 = 2;',
      'src/b.js': 'export const b = 3;\nexport const b2 = 4;',
      'src/c.js': 'export const c = 5;'
    },
    script: [
      [call('rb1', 'read_batch', {
        files: [
          { file_path: 'src/a.js' },
          { file_path: 'src/b.js', offset: 2, limit: 1 },
          { file_path: 'src/c.js' }
        ]
      })],
      [{ type: 'text', text: 'All three files inspected in one round-trip.' }]
    ]
  });

  try {
    await host.run('Inspect a.js, b.js, and c.js');
    assert.equal(host.errors.length, 0);
    assert.equal(host.requests.length, 2);
    // Underlying native read tool was invoked 3 times via ToolExecutionPipeline
    assert.equal(host.calls.filter(c => c.name === 'read').length, 3);

    const ptcEvents = host.events.filter(e => e.type === 'tool/ptc-dispatch');
    assert.equal(ptcEvents.length, 3);

    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.batchesExecuted, 1);
    assert.equal(stats.filesRequested, 3);
    assert.equal(stats.filesSucceeded, 3);
    assert.equal(stats.filesFailed, 0);

    // FileMutationPolicy also observed the files read via read_batch
    const mutationSummary = host.fileMutationPolicy.getSummary(host.agent.session);
    assert.equal(mutationSummary.observedFiles, 3);
  } finally {
    await host.dispose();
  }
});

test('read_batch tolerates partial missing files without losing valid reads in the same batch', async () => {
  const host = await createTestRuntime({
    files: {
      'exists.txt': 'Valid file content'
    },
    script: [
      [call('rb-partial', 'read_batch', {
        files: [
          { file_path: 'exists.txt' },
          { file_path: 'missing.txt' }
        ]
      })],
      [{ type: 'text', text: 'Handled partial batch result.' }]
    ]
  });

  try {
    await host.run('Read exists.txt and missing.txt');
    assert.equal(host.errors.length, 0);
    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.filesSucceeded, 1);
    assert.equal(stats.filesFailed, 1);

    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].data.message.isError, false);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /Valid file content/);
    assert.match(output, /\[ERROR\]/);
  } finally {
    await host.dispose();
  }
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

test('read_batch truncates oversized single lines and enforces maxTotalBytes budget', async () => {
  const longLine = 'X'.repeat(500);
  const host = await createTestRuntime({
    optimizerConfig: {
      compositeTools: {
        enabled: true,
        maxLineChars: 100,
        maxTotalBytes: 600
      }
    },
    files: {
      'minified.js': longLine,
      'second.txt': 'line A\nline B\nline C\n'.repeat(15),
      'third.txt': 'line D\nline E\n'.repeat(15)
    },
    script: [
      [call('rb-budget', 'read_batch', {
        files: [
          { file_path: 'minified.js' },
          { file_path: 'second.txt' },
          { file_path: 'third.txt' }
        ]
      })],
      [{ type: 'text', text: 'Budget verified.' }]
    ]
  });

  try {
    await host.run('Test read_batch output budget');
    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults.length, 1);
    const output = toolResults[0].data.message.content.map(b => b.text).join('\n');
    assert.match(output, /\[line truncated: \+403 chars\]/);
    assert.match(output, /=== \[TRUNCATED\] third\.txt ===/);
    assert.match(output, /maxTotalBytes=600/);
    assert.doesNotMatch(output, new RegExp('X'.repeat(200)));
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
