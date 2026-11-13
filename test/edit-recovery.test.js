import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEditFailureHint, findBestEditMatch, isEditMatchFailure } from '../src/index.js';
import { createTestRuntime, call } from './support/runtime.js';

test('editRecovery detects whitespace/indentation mismatch and enables immediate next-step edit without read', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-recovery-ws-'));
  const filePath = path.join(tempDir, 'service.ts');
  const lines = [
    '// header',
    ...Array.from({ length: 18 }, (_, i) => `export const pad${i} = ${i};`),
    'export function computeTotal(items: number[]) {',
    '\tconst base = 10;',
    '\tconst sum = items.reduce((a, b) => a + b, 0);',
    '\treturn base + sum;',
    '}',
    '// footer'
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  const host = await createTestRuntime({
    editHandler(args) {
      const raw = fs.readFileSync(args.file_path, 'utf8');
      if (!raw.includes(args.old_string)) {
        throw new Error('old_string not found in target file');
      }
      fs.writeFileSync(args.file_path, raw.replace(args.old_string, args.new_string), 'utf8');
      return `Edited ${args.file_path}`;
    },
    script: [
      [call('e-wrong-indent', 'edit', {
        file_path: filePath,
        // Wrong indentation: 2 spaces instead of tabs
        old_string: '  const base = 10;\n  const sum = items.reduce((a, b) => a + b, 0);',
        new_string: '\tconst base = 20;\n\tconst sum = items.reduce((a, b) => a + b, 0);'
      })],
      [call('e-fixed', 'edit', {
        file_path: filePath,
        old_string: '\tconst base = 10;\n\tconst sum = items.reduce((a, b) => a + b, 0);',
        new_string: '\tconst base = 20;\n\tconst sum = items.reduce((a, b) => a + b, 0);'
      })],
      [{ type: 'text', text: 'Recovered in one hop without read.' }]
    ]
  });

  try {
    await host.run('Edit file with wrong indent first');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 2);
    assert.equal(results[0].data.message.isError, true);

    const errText = results[0].data.message.content.map(b => b.text).join('\n');
    assert.match(errText, /\[edit-recovery\] Exact match after whitespace\/indentation normalization at lines 21-22/);
    assert.match(errText, /file uses tabs indentation whereas old_string uses spaces/);
    assert.match(errText, /21 \| \tconst base = 10;/);
    assert.match(errText, /22 \| \tconst sum = items\.reduce/);

    assert.equal(results[1].data.message.isError, false);
    assert.match(fs.readFileSync(filePath, 'utf8'), /\tconst base = 20;/);
    // Never issued a read call!
    assert.equal(host.calls.filter(c => c.name === 'read').length, 0);

    const stats = host.ctx.get('editRecovery').getStats(host.agent.session);
    assert.equal(stats.inspected, 1);
    assert.equal(stats.hintsAttached, 1);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('findBestEditMatch locates rare anchor lines amidst noisy braces and falls back to token similarity for single-line drift', () => {
  const doc = [
    ...Array.from({ length: 20 }, (_, i) => `function helper${i}() {\n  return true;\n}`).join('\n').split('\n'),
    'async function processInvoiceBatch(records, gateway) {',
    '  if (!records.length) {',
    '    return { ok: true, count: 0 };',
    '  }',
    '  const normalized = records.map(r => r.amountCents * 100);',
    '  return gateway.submitBatch(normalized);',
    '}',
    ...Array.from({ length: 15 }, (_, i) => `function tail${i}() {\n  return false;\n}`).join('\n').split('\n')
  ].join('\n');

  const multiFuzzy = findBestEditMatch(doc, [
    'async function processInvoiceBatch(records, gateway) {',
    '  if (!records.length) {',
    '    return { ok: false };',
    '  }',
    '  const normalized = records.map(r => r.amountCents * 10);',
    '}'
  ].join('\n'));
  assert.equal(multiFuzzy.kind, 'fuzzy-match');
  assert.ok(multiFuzzy.startLine >= 60 && multiFuzzy.startLine <= 63);

  const singleDrift = findBestEditMatch(doc, 'const normalized = records.map(r => r.totalCents * 100);');
  assert.equal(singleDrift.kind, 'fuzzy-match');
  assert.equal(singleDrift.startLine, 65);

  const hint = buildEditFailureHint(doc, 'const normalized = records.map(r => r.totalCents * 100);', {
    filePath: 'invoice.ts',
    contextLines: 4,
    maxSnippetLines: 12
  });
  assert.match(hint, /Closest match near lines 65-65/);
  assert.match(hint, /65 \|   const normalized = records\.map/);
  assert.ok(hint.split('\n').length <= 13);
});

test('buildEditFailureHint reports exact line locations for multiple matches', () => {
  const doc = [
    'const first = 1;',
    'const target = oldValue;',
    'const mid = 2;',
    'const target = oldValue;',
    'const tail = 3;',
    'const target = oldValue;'
  ].join('\n');

  const hint = buildEditFailureHint(doc, 'const target = oldValue;', {
    filePath: 'dup.ts',
    maxMultiMatchLocations: 2
  });
  assert.match(hint, /contains 3 exact matches \(lines 2, 4, \.\.\. \(3 total\)\)/);
  assert.match(hint, /Pass replace_all=true/);
  assert.match(hint, /2 \| const target = oldValue;/);
  assert.match(hint, /4 \| const target = oldValue;/);
});

test('editRecovery never leaks file content on permission, sandbox, ENOENT, or runtimePolicy denials', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-recovery-sec-'));
  const secretFile = path.join(tempDir, 'secret.env');
  fs.writeFileSync(secretFile, 'API_KEY=super-secret-token-value\n', 'utf8');

  assert.equal(isEditMatchFailure('Permission denied by sandbox policy'), false);
  assert.equal(isEditMatchFailure('ENOENT: no such file or directory'), false);
  assert.equal(isEditMatchFailure('[runtime-policy] Execution blocked: NO_PROGRESS', 'NO_PROGRESS'), false);
  assert.equal(isEditMatchFailure('old_string not found in file'), true);

  const host = await createTestRuntime({
    editHandler() {
      throw new Error('Permission denied: sandbox forbids editing this file');
    },
    script: [
      [call('e-denied', 'edit', {
        file_path: secretFile,
        old_string: 'API_KEY=wrong',
        new_string: 'API_KEY=none'
      })],
      [{ type: 'text', text: 'Handled denied edit safely.' }]
    ]
  });

  try {
    await host.run('Attempt sandbox-denied edit');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1);
    const errText = results[0].data.message.content.map(b => b.text).join('\n');
    assert.doesNotMatch(errText, /super-secret-token-value/);
    assert.doesNotMatch(errText, /\[edit-recovery\]/);

    const stats = host.ctx.get('editRecovery').getStats(host.agent.session);
    assert.equal(stats.hintsAttached, 0);
    assert.equal(stats.skipped, 1);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('editRecovery enriches both edit_batch sub-dispatch failures and edit_batch pre-flight failures', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-batch-rec-'));
  const singleFile = path.join(tempDir, 'single.ts');
  const multiFile = path.join(tempDir, 'multi.ts');
  fs.writeFileSync(singleFile, 'line1\nexport const port = 3000;\nline3\n', 'utf8');
  fs.writeFileSync(multiFile, 'stepOne();\nconst mode = "production";\nstepThree();\n', 'utf8');

  const host = await createTestRuntime({
    editHandler(args) {
      const raw = fs.readFileSync(args.file_path, 'utf8');
      if (!raw.includes(args.old_string)) {
        throw new Error('old_string not found');
      }
      fs.writeFileSync(args.file_path, raw.replace(args.old_string, args.new_string), 'utf8');
      return `Edited ${args.file_path}`;
    },
    script: [
      [call('eb-mix', 'edit_batch', {
        edits: [
          // Single edit on singleFile -> dispatched via pipeline -> enriched by tools/post-execute
          { file_path: singleFile, old_string: 'export const port = 8080;', new_string: 'export const port = 9000;' },
          // Multi edit on multiFile -> hunk #2 fails during pre-flight -> enriched by simulateEditsOnContent
          { file_path: multiFile, old_string: 'stepOne();', new_string: 'stepOneUpdated();' },
          { file_path: multiFile, old_string: 'const mode = "staging";', new_string: 'const mode = "dev";' }
        ]
      })],
      [{ type: 'text', text: 'Received line-numbered hints for both paths.' }]
    ]
  });

  try {
    await host.run('Test edit_batch recovery hints');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1);
    assert.equal(results[0].data.message.isError, true);

    const output = results[0].data.message.content.map(b => b.text).join('\n');
    // Sub-dispatch enriched via tools/post-execute
    assert.match(output, /2 \| export const port = 3000;/);
    // Pre-flight enriched against simulated content (hunk #1 applied in simulation!)
    assert.match(output, /1 \| stepOneUpdated\(\);/);
    assert.match(output, /2 \| const mode = "production";/);
    // Neither file was modified on disk
    assert.equal(fs.readFileSync(multiFile, 'utf8'), 'stepOne();\nconst mode = "production";\nstepThree();\n');
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('editRecovery supports ctx.fs.readFile and skips oversized files cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-rec-fs-'));
  const bigFile = path.join(tempDir, 'huge.log');
  fs.writeFileSync(bigFile, 'A'.repeat(10000), 'utf8');

  const host = await createTestRuntime({
    optimizerConfig: {
      editRecovery: {
        enabled: true,
        maxInspectBytes: 4096
      }
    },
    configureTools(ctx) {
      const fsService = ctx.get('fs');
      fsService.readFile = async filePath => {
        if (filePath === 'mem://file.ts') {
          return 'const alpha = 1;\nconst beta = 2;\n';
        }
        return fs.readFileSync(filePath, 'utf8');
      };
    },
    editHandler() {
      throw new Error('old_string not found');
    },
    script: [
      [call('e-mem', 'edit', { file_path: 'mem://file.ts', old_string: 'const beta = 99;', new_string: 'const beta = 3;' })],
      [call('e-huge', 'edit', { file_path: bigFile, old_string: 'BBBB', new_string: 'CCCC' })],
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check ctx.fs and maxInspectBytes');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 2);
    const out1 = results[0].data.message.content.map(b => b.text).join('\n');
    const out2 = results[1].data.message.content.map(b => b.text).join('\n');

    assert.match(out1, /2 \| const beta = 2;/);
    assert.doesNotMatch(out2, /\[edit-recovery\]/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
