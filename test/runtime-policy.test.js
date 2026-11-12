import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { normalizePath, sizeBucket, computeFingerprint } from '../src/runtime-policy.js';

test('normalizePath and computeFingerprint produce deterministic values across platforms', () => {
  assert.equal(normalizePath('E:\\Github\\Foo\\bar.js'), 'e:/github/foo/bar.js');
  assert.equal(normalizePath('src\\Foo\\index.js', 'E:\\Github\\Repo'), 'e:/github/repo/src/foo/index.js');
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

test('runtimePolicy treats Windows paths with different casing as the same failed invocation', async () => {
  const host = await createTestRuntime({
    optimizerConfig: {
      runtimePolicy: { mode: 'enforce', noProgressLimit: 2 }
    },
    readHandler() {
      throw new Error('stable missing-file failure');
    },
    script: [
      [call('case-1', 'read', { file_path: 'E:\\Workspace\\Repo\\Missing.txt' })],
      [call('case-2', 'read', { file_path: 'e:\\workspace\\repo\\missing.txt' })],
      [call('case-3', 'read', { file_path: 'E:\\WORKSPACE\\REPO\\MISSING.TXT' })],
      [{ type: 'text', text: 'Stopped retrying the missing file.' }]
    ]
  });

  try {
    await host.run('Read the missing file');
    assert.equal(host.errors.length, 0);
    assert.equal(host.calls.length, 2);
    const toolResults = host.events.filter(event => event.type === 'tool/result');
    const blockedText = toolResults.at(-1).data.message.content.map(block => block.text).join('');
    assert.match(blockedText, /NO_PROGRESS/);
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

test('runtimePolicy blocks chained heavy concurrent or publishing tasks while allowing pure git workflow chaining', async () => {
  const chainedNpmTestCmd = 'npm test && git status';
  const chainedBuildCmd = 'npm run build && git status';
  const chainedVitestCmd = 'vitest run && git status';
  const chainedPublishCmd = 'git status && npm publish';
  const chainedGitWorkflowCmd = 'git add . && git commit -m "feat" && git push origin main';
  const commitWithKeywordCmd = 'git add . && git commit -m "docs: run tests and publish"';
  const standaloneHeavyCmd = 'npm test';

  const host = await createTestRuntime({
    optimizerConfig: {
      runtimePolicy: {
        mode: 'enforce',
        disallowChainedNetworkCommands: true
      }
    },
    script: [
      [call('c_block1', 'bash', { command: chainedNpmTestCmd })],
      [call('c_block2', 'bash', { command: chainedBuildCmd })],
      [call('c_block3', 'bash', { command: chainedVitestCmd })],
      [call('c_block4', 'bash', { command: chainedPublishCmd })],
      [call('c_git', 'bash', { command: chainedGitWorkflowCmd })],
      [call('c_commit', 'bash', { command: commitWithKeywordCmd })],
      [call('c_standalone', 'bash', { command: standaloneHeavyCmd })],
      [{ type: 'text', text: 'All operations safely executed.' }]
    ]
  });

  try {
    await host.run('Run heavy command checks');
    assert.equal(host.errors.length, 0);
    // 4 blocked due to chained heavy tasks (npm test, npm run build, vitest, npm publish)
    // 3 allowed: chained pure git, commit with keywords, and standalone heavy task
    assert.equal(host.calls.length, 3);
    assert.equal(host.calls[0].id, 'c_git');
    assert.equal(host.calls[1].id, 'c_commit');
    assert.equal(host.calls[2].id, 'c_standalone');

    const summary = host.runtimePolicy.getSummary(host.agent.session);
    assert.equal(summary.shellPayloadBlocks, 4);
  } finally {
    await host.dispose();
  }
});

test('runtimePolicy blocks playwright-cli commands using file: protocol', async () => {
  const fileCmd = 'playwright-cli open "file:///${PWD}/index.html"';
  const httpCmd = 'playwright-cli open "http://127.0.0.1:8080/index.html"';

  const host = await createTestRuntime({
    optimizerConfig: {
      runtimePolicy: {
        mode: 'enforce'
      }
    },
    script: [
      [call('p1', 'bash', { command: fileCmd })],
      [call('p2', 'bash', { command: httpCmd })],
      [{ type: 'text', text: 'Browser navigation completed.' }]
    ]
  });

  try {
    await host.run('Run playwright commands');
    assert.equal(host.errors.length, 0);
    // p1 is blocked pre-execute; only p2 is allowed and executed
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].id, 'p2');

    const summary = host.runtimePolicy.getSummary(host.agent.session);
    assert.equal(summary.shellPayloadBlocks, 1);
  } finally {
    await host.dispose();
  }
});
