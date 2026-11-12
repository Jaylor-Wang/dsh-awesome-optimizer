import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestRuntime } from './support/runtime.js';
import { CUSTOM_PROMPT_SECTION, detectPythonEnv, resetPythonCacheForTesting, formatEnvironmentFacts } from '../src/index.js';

function extractPromptText(request) {
  if (!request) return '';
  return request.messages
    .flatMap(m => m.content)
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

test('customPrompt loads global and workspace SYSTEM.md and injects into system prompt', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-prompt-test-'));
  const globalDshDir = path.join(tempDir, 'global-dsh');
  const wsDir = path.join(tempDir, 'workspace');
  const wsDshDir = path.join(wsDir, '.dsh');

  fs.mkdirSync(globalDshDir, { recursive: true });
  fs.mkdirSync(wsDshDir, { recursive: true });

  const globalFile = path.join(globalDshDir, 'SYSTEM.md');
  const wsFile = path.join(wsDshDir, 'SYSTEM.md');

  fs.writeFileSync(globalFile, '# Global Developer Instructions\nAlways follow clean code.', 'utf8');
  fs.writeFileSync(wsFile, '# Repository Instructions\nStrictly use ESM format.', 'utf8');

  const host = await createTestRuntime({
    workingDirectory: wsDir,
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        workspaceFile: '.dsh/SYSTEM.md',
        placement: 'suffix',
        mergeStrategy: 'concat',
        hotReload: false
      }
    },
    script: [
      [{ type: 'text', text: 'Task finished.' }]
    ]
  });

  try {
    await host.run('Run initial task with custom prompts');

    assert.equal(host.errors.length, 0);
    assert.equal(host.requests.length, 1);

    // Verify system prompt in the request
    const systemPromptText = extractPromptText(host.requests[0]);

    // Must contain both global and workspace instructions
    assert.match(systemPromptText, /Global Developer Instructions/);
    assert.match(systemPromptText, /Always follow clean code/);
    assert.match(systemPromptText, /Repository Instructions/);
    assert.match(systemPromptText, /Strictly use ESM format/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('customPrompt supports workspace-override merge strategy', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-override-test-'));
  const globalFile = path.join(tempDir, 'global-SYSTEM.md');
  const wsDir = path.join(tempDir, 'project');
  const wsFile = path.join(wsDir, 'SYSTEM.md');

  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(globalFile, 'GLOBAL_PROMPT_CONTENT', 'utf8');
  fs.writeFileSync(wsFile, 'WORKSPACE_OVERRIDE_PROMPT', 'utf8');

  const host = await createTestRuntime({
    workingDirectory: wsDir,
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        workspaceFile: 'SYSTEM.md',
        mergeStrategy: 'workspace-override',
        hotReload: false
      }
    },
    script: [
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check override');

    const systemPromptText = extractPromptText(host.requests[0]);

    // Workspace override must be present, global should be skipped
    assert.match(systemPromptText, /WORKSPACE_OVERRIDE_PROMPT/);
    assert.doesNotMatch(systemPromptText, /GLOBAL_PROMPT_CONTENT/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('customPrompt supports replace-all placement mode to prune official verbose sections', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-replace-all-test-'));
  const globalFile = path.join(tempDir, 'SYSTEM.md');
  fs.writeFileSync(globalFile, 'STANDALONE_REFINED_PROMPT', 'utf8');

  const host = await createTestRuntime({
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        placement: 'replace-all',
        hotReload: false
      }
    },
    script: [
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check replace-all');
    const systemPromptText = extractPromptText(host.requests[0]);

    assert.match(systemPromptText, /STANDALONE_REFINED_PROMPT/);
    assert.doesNotMatch(systemPromptText, /Default Persona/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('customPrompt hot-reloads file changes reactively without restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-hotreload-test-'));
  const globalFile = path.join(tempDir, 'SYSTEM.md');
  fs.writeFileSync(globalFile, 'INITIAL_HOTRELOAD_PROMPT', 'utf8');

  const host = await createTestRuntime({
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        placement: 'suffix',
        hotReload: true
      }
    },
    script: [
      [{ type: 'text', text: 'Step 1 done.' }],
      [{ type: 'text', text: 'Step 2 done.' }]
    ]
  });

  try {
    // Turn 1: Initial content
    await host.run('Turn 1');
    assert.equal(host.requests.length, 1);
    assert.match(extractPromptText(host.requests[0]), /INITIAL_HOTRELOAD_PROMPT/);

    // Modify SYSTEM.md on disk during runtime
    fs.writeFileSync(globalFile, 'UPDATED_HOTRELOAD_PROMPT_V2', 'utf8');

    // Allow brief time for fs.watch event debounce
    await new Promise(r => setTimeout(r, 120));

    // Turn 2: Should immediately reflect new prompt
    await host.run('Turn 2');
    assert.equal(host.requests.length, 2);
    assert.match(extractPromptText(host.requests[1]), /UPDATED_HOTRELOAD_PROMPT_V2/);
    assert.doesNotMatch(extractPromptText(host.requests[1]), /INITIAL_HOTRELOAD_PROMPT/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('customPrompt injects host environment facts to eliminate exploratory probing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-env-facts-test-'));
  const globalFile = path.join(tempDir, 'SYSTEM.md');
  fs.writeFileSync(globalFile, '# Refined Directives\nExecute cleanly.', 'utf8');

  const host = await createTestRuntime({
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        placement: 'replace-all',
        injectEnvironmentFacts: true,
        hotReload: false
      }
    },
    script: [
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check env facts');
    const systemPromptText = extractPromptText(host.requests[0]);

    assert.match(systemPromptText, /Host Environment & Tooling Facts/);
    assert.match(systemPromptText, /Node\.js/);
    assert.match(systemPromptText, /Standalone CLIs: playwright-cli/);
    assert.match(systemPromptText, /NEVER require\/import as node modules/);
    assert.match(systemPromptText, /playwright-cli blocks "file:" URLs/);
    assert.match(systemPromptText, /NEVER run exploratory probing/);
  } finally {
    await host.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('detectPythonEnv safely detects and caches python or handles missing runtime', () => {
  // 1. Mock detected python
  resetPythonCacheForTesting();
  let calls = 0;
  const mockSpawnSuccess = (bin) => {
    calls++;
    if (bin === 'python') return { status: 0, stdout: 'Python 3.12.2\n' };
    return { status: 1 };
  };
  const py = detectPythonEnv(mockSpawnSuccess);
  assert.deepEqual(py, { bin: 'python', version: 'Python 3.12.2' });
  // Second call should hit memoized cache without invoking spawnSyncFn
  const cached = detectPythonEnv(mockSpawnSuccess);
  assert.equal(cached, py);
  assert.equal(calls, 1);

  const factsWithPy = formatEnvironmentFacts({ version: 'v22.0.0', platform: 'linux', arch: 'x64' }, () => py);
  assert.match(factsWithPy, /Node\.js v22\.0\.0, Python 3\.12\.2 \(python\) on linux \(x64\)\./);

  // 2. Mock missing python
  resetPythonCacheForTesting();
  const mockSpawnFail = () => ({ status: 1 });
  const pyMissing = detectPythonEnv(mockSpawnFail);
  assert.equal(pyMissing, null);

  const factsNoPy = formatEnvironmentFacts({ version: 'v24.0.0', platform: 'win32', arch: 'x64' }, () => null);
  assert.match(factsNoPy, /Node\.js v24\.0\.0 \(Python not detected; use Node\.js for ad-hoc scripts\) on win32 \(x64\)\./);

  // Restore live cache
  resetPythonCacheForTesting();
});
