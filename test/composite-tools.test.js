import assert from 'node:assert/strict';
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
