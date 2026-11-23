import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { normalizePath, sizeBucket, computeFingerprint, classifyToolCall } from '../src/runtime-policy.js';
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

test('runtimePolicy allows test and build chaining by default and keeps npm publish standalone', async () => {
  const host = await createTestRuntime({
    script: [
      [call('test', 'bash', { command: 'npm test && git status' })],
      [call('build', 'bash', { command: 'npm run build && git status' })],
      [call('vitest', 'bash', { command: 'vitest run; git status' })],
      [call('publish-chain', 'bash', { command: 'git status && npm publish' })],
      [call('publish-standalone', 'bash', { command: 'npm publish' })],
      [{ type: 'text', text: 'Complete.' }]
    ]
  });
  try {
    await host.run('Check the default Bash policy');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(host.calls.map(({ id }) => id), ['test', 'build', 'vitest', 'publish-standalone']);
    assert.equal(host.runtimePolicy.getSummary(host.agent.session).shellPayloadBlocks, 1);
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

test('classifyToolCall classifies edit_batch, eval_python, and eval_node accurately', () => {
  const eb = classifyToolCall('edit_batch', {
    edits: [
      { file_path: 'a.js', old_string: 'old1', new_string: 'new1' },
      { file_path: 'b.js', old_string: 'old2', new_string: 'new22' }
    ]
  });
  assert.equal(eb.opClass, 'edit');
  assert.equal(eb.targetPath, 'a.js,b.js');
  assert.equal(eb.byteLength, 17);

  const ep = classifyToolCall('eval_python', { code: 'print(123)' });
  assert.equal(ep.opClass, 'eval');
  assert.equal(ep.targetPath, 'kernel');
  assert.equal(ep.byteLength, 10);

  const en = classifyToolCall('eval_node', { code: '1+1', reset: true });
  assert.equal(en.opClass, 'eval');
  assert.equal(en.targetPath, 'reset');
  assert.equal(en.byteLength, 3);
});

test('runtimePolicy isolates nested find_and_read sub-calls and guards flagged inline scripts without false positives in quotes', async () => {
  const flaggedInline = `pwsh -NoProfile -Command "${'Write-Output 1; '.repeat(40)}"`;
  const safeCommit = 'git commit -m "docs: node -e \'x\' and cat << EOF and playwright-cli open file:///tmp/a.html"';

  const host = await createTestRuntime({
    files: {
      'ok.txt': 'hello target\nline2'
    },
    grepHandler() {
      // Emit multiple non-existent paths to simulate failing nested read sub-calls
      return 'Found 3 matches\n\nmissing1.txt\nLine 1: target\n\nmissing2.txt\nLine 1: target\n\nok.txt\nLine 1: hello target';
    },
    optimizerConfig: {
      runtimePolicy: { mode: 'enforce', noProgressLimit: 2, maxInlineScriptBytes: 512 }
    },
    script: [
      [call('fr1', 'find_and_read', {
        patterns: ['target']
      })],
      [call('b_inline', 'bash', { command: flaggedInline })],
      [call('b_commit', 'bash', { command: safeCommit })],
      [{ type: 'text', text: 'Finished safely.' }]
    ]
  });

  try {
    await host.run('Verify isolation and shell quoting');
    assert.equal(host.errors.length, 0);
    const summary = host.runtimePolicy.getSummary(host.agent.session);
    assert.equal(summary.noProgressHits, 0);
    assert.equal(summary.shellPayloadBlocks, 1);
    assert.ok(host.calls.some(c => c.id === 'b_commit'));
    assert.ok(!host.calls.some(c => c.id === 'b_inline'));
  } finally {
    await host.dispose();
  }
});

test('runtimePolicy handles tricky shell quoting, heredocs, playwright flags, and avoids cross-segment false positives', async () => {
  const host = await createTestRuntime({
    optimizerConfig: { runtimePolicy: { mode: 'enforce' } },
    script: [
      // Quoted double-quotes inside single quotes must not swallow `&& npm publish`
      [call('q-bypass', 'bash', { command: `echo '"' && npm publish && echo '"'` })],
      // POSIX single quotes do not escape backslash before closing quote
      [call('win-sq', 'bash', { command: `echo 'C:\\foo\\' && npm publish` })],
      // || and newline chaining of npm publish
      [call('or-pub', 'bash', { command: 'git status || npm publish' })],
      [call('nl-pub', 'bash', { command: 'git status\nnpm publish' })],
      // Non-cat heredoc payload
      [call('tee-heredoc', 'bash', { command: `tee out.txt <<EOF\n${'x'.repeat(300)}\nEOF` })],
      // Flagged playwright-cli open file://
      [call('pw-flag', 'bash', { command: 'playwright-cli --session=s1 open file:///tmp/index.html' })],
      // Safe cross-segment and quoted playwright-cli commands must NOT false-positive
      [call('pw-safe-echo', 'bash', { command: 'echo "playwright-cli open file:///tmp/index.html" && playwright-cli snapshot' })],
      [call('pw-safe-eval', 'bash', { command: `playwright-cli eval "console.log('open file:///tmp/a')"` })],
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Test hardened shell parser');
    assert.deepEqual(host.calls.map(c => c.id), ['pw-safe-echo', 'pw-safe-eval']);
    assert.equal(host.runtimePolicy.getSummary(host.agent.session).shellPayloadBlocks, 6);
  } finally {
    await host.dispose();
  }
});

test('runtimePolicy blocks alternating read-only failure loops and resets after mutating progress', async () => {
  const host = await createTestRuntime({
    files: { 'ok.txt': 'ok' },
    optimizerConfig: { runtimePolicy: { mode: 'enforce', noProgressLimit: 2 } },
    script: [
      [call('f1', 'read', { file_path: 'missing.txt' })],
      [call('ok1', 'read', { file_path: 'ok.txt' })],
      [call('f2', 'read', { file_path: 'missing.txt' })],
      [call('ok2', 'read', { file_path: 'ok.txt' })],
      // 3rd identical failure despite intervening read-only calls -> blocked!
      [call('f3-blocked', 'read', { file_path: 'missing.txt' })],
      // Mutating tool creates the missing file -> resets circuit breaker
      [call('w-fix', 'write', { file_path: 'missing.txt', content: 'fixed!' })],
      [call('r-after-fix', 'read', { file_path: 'missing.txt' })],
      [{ type: 'text', text: 'Recovered after mutation.' }]
    ]
  });

  try {
    await host.run('Alternating failure loop with recovery');
    assert.deepEqual(host.calls.map(c => c.id), ['f1', 'ok1', 'f2', 'ok2', 'w-fix', 'r-after-fix']);
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.match(results[4].data.message.content.map(b => b.text).join(''), /NO_PROGRESS/);
    assert.equal(results[6].data.message.isError, false);
  } finally {
    await host.dispose();
  }
});

test('runtimePolicy and fileMutationPolicy hydrate initial session workingDirectory on the first turn', async () => {
  const host = await createTestRuntime({
    workingDirectory: 'E:\\Workspace\\ProjectA',
    files: { 'E:/Workspace/ProjectA/existing.ts': 'export const v = 1;\n' },
    optimizerConfig: {
      runtimePolicy: { mode: 'enforce', noProgressLimit: 2 },
      fileMutationPolicy: { mode: 'enforce', minLargeWriteBytes: 64 }
    },
    script: [
      [call('w-rel', 'write', { file_path: 'existing.ts', content: 'X'.repeat(100) })],
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check initial cwd hydration');
    const mutationSummary = host.fileMutationPolicy.getSummary(host.agent.session);
    assert.equal(mutationSummary.largeWritesBlocked, 1);
    assert.equal(host.calls.filter(c => c.name === 'write').length, 0);
  } finally {
    await host.dispose();
  }
});
