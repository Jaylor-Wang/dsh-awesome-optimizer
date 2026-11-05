import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { normalizePath, sizeBucket, computeFingerprint } from '../src/runtime-policy.js';

test('normalizePath and computeFingerprint produce deterministic values across platforms', () => {
  assert.equal(normalizePath('E:\\Github\\foo\\bar.js'), 'e:/Github/foo/bar.js');
  assert.equal(normalizePath('src/index.js', 'E:\\Github\\repo'), 'e:/Github/repo/src/index.js');
  assert.equal(sizeBucket(0), '0');
  assert.equal(sizeBucket(512), '<1K');
  assert.equal(sizeBucket(4096), '1K-8K');
  assert.equal(sizeBucket(16384), '8K-64K');

  const fp1 = computeFingerprint({
    name: 'read',
    targetPath: 'E:\\Github\\a.txt',
    opClass: 'read',
    errorCode: 'ENOENT',
    isError: true,
    byteLength: 0
  });
  const fp2 = computeFingerprint({
    name: 'read',
    targetPath: 'e:/Github/a.txt',
    opClass: 'read',
    errorCode: 'ENOENT',
    isError: true,
    byteLength: 0
  });
  assert.equal(fp1, fp2);
});

test('runtimePolicy blocks repeated identical failing tool invocations after noProgressLimit', async () => {
  const host = await createTestRuntime({
    optimizerConfig: {
      runtimePolicy: { mode: 'enforce', noProgressLimit: 2 }
    },
    script: [
      [call('c1', 'read', { file_path: 'missing.txt' })],
      [call('c2', 'read', { file_path: 'missing.txt' })],
      [call('c3', 'read', { file_path: 'missing.txt' })],
      [{ type: 'text', text: 'Stopped retrying missing.txt.' }]
    ]
  });

  try {
    await host.run('Read missing.txt');
    assert.equal(host.errors.length, 0);
    const summary = host.runtimePolicy.getSummary(host.agent.session);
    assert.equal(host.calls.length, 2, `Expected 2 calls, got ${host.calls.length}. Summary: ${JSON.stringify(summary)}`);
    assert.ok(summary.noProgressHits >= 1);
    assert.equal(summary.failedToolExecutions, 2);

    const toolResults = host.events.filter(e => e.type === 'tool/result');
    assert.equal(toolResults.length, 3);
    const thirdResultText = toolResults[2].data.message.content.map(b => b.text).join('');
    assert.match(thirdResultText, /NO_PROGRESS/);
  } finally {
    await host.dispose();
  }
});

test('runtimePolicy blocks oversized shell commands and large inline scripts on Windows', async () => {
  const oversizedCmd = `echo "${'a'.repeat(4200)}"`;
  const inlineNodeScript = `node -e "${'console.log(1); '.repeat(45)}"`;

  const host = await createTestRuntime({
    optimizerConfig: {
      runtimePolicy: {
        mode: 'enforce',
        maxShellCommandBytes: 4096,
        maxInlineScriptBytes: 512
      }
    },
    script: [
      [call('b1', 'bash', { command: oversizedCmd })],
      [call('b2', 'bash', { command: inlineNodeScript })],
      [call('b3', 'bash', { command: 'node scripts/small.js' })],
      [{ type: 'text', text: 'Used file path execution.' }]
    ]
  });

  try {
    await host.run('Run script');
    assert.equal(host.errors.length, 0);
    // b1 and b2 are blocked pre-execute; only b3 executes
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].id, 'b3');

    const summary = host.runtimePolicy.getSummary(host.agent.session);
    assert.equal(summary.shellPayloadBlocks, 2);
  } finally {
    await host.dispose();
  }
});
