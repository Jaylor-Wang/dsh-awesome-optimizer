import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestRuntime } from './support/runtime.js';
import { CUSTOM_PROMPT_SECTION } from '../src/index.js';

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

test('customPrompt supports replace-persona-suffix placement mode', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-replace-test-'));
  const globalFile = path.join(tempDir, 'SYSTEM.md');
  fs.writeFileSync(globalFile, 'CUSTOM_SUFFIX_OVERWRITE', 'utf8');

  const host = await createTestRuntime({
    optimizerConfig: {
      customPrompt: {
        enabled: true,
        globalFile,
        placement: 'replace-persona-suffix',
        hotReload: false
      }
    },
    script: [
      [{ type: 'text', text: 'Done.' }]
    ]
  });

  try {
    await host.run('Check replace-persona-suffix');
    const systemPromptText = extractPromptText(host.requests[0]);

    assert.match(systemPromptText, /CUSTOM_SUFFIX_OVERWRITE/);
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
