import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lintPrompt, fixPrompt, lintPromptFile, PROMPT_LINT_RULES } from '../src/index.js';

test('lintPrompt dynamically checks tools against active profile/preset', () => {
  const prompt = [
    '# Test Prompt',
    '- Shell: harness `bash` only (`tool-pwsh` disabled). Launch `pwsh.exe` from `bash` when needed.',
    '- Web: harness `web-search-deepseek` is disabled.'
  ].join('\n');

  // Scenario 1: activeTools contains ONLY 'bash' (tool-pwsh is NOT loaded in preset)
  const resultNotLoaded = lintPrompt(prompt, { activeTools: ['bash'] });
  assert.ok(resultNotLoaded.issues.some(i =>
    i.ruleId === PROMPT_LINT_RULES.TOOL_PRESET_MISMATCH &&
    i.message.includes('tool-pwsh') &&
    i.message.includes('not registered')
  ));

  // Scenario 2: activeTools ACTUALLY CONTAINS 'tool-pwsh' (user enabled it in preset!)
  const resultLoaded = lintPrompt(prompt, { activeTools: ['bash', 'tool-pwsh'] });
  assert.ok(resultLoaded.issues.some(i =>
    i.ruleId === PROMPT_LINT_RULES.TOOL_PRESET_MISMATCH &&
    i.message.includes('tool-pwsh') &&
    i.message.includes('actively loaded')
  ));

  // Scenario 3: Offline mode without activeTools - must NOT make subjective assumptions
  const resultOffline = lintPrompt(prompt);
  assert.ok(resultOffline.issues.some(i =>
    i.ruleId === PROMPT_LINT_RULES.UNVERIFIED_TOOL_DISABLEMENT
  ));
  // Unverified tool notes are info-only and do not penalize score
  assert.equal(resultOffline.score, 100);
});

test('lintPrompt detects weak modals, legacy jargon, and unclosed backticks', () => {
  const dirtyPrompt = [
    '# Bad Prompt',
    '- Bias toward action over speculation (no workflows, ralph, or delegation).',
    '- Please try to follow this rule.',
    '- This line has an unclosed `backtick.'
  ].join('\n');

  const result = lintPrompt(dirtyPrompt);

  assert.ok(result.score < 80, `Expected score to drop due to multiple issues, got ${result.score}`);
  assert.ok(result.issues.length >= 4);

  const ruleIds = result.issues.map(i => i.ruleId);
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.WEAK_MODALS));
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.LEGACY_JARGON));
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.UNCLOSED_BACKTICKS));
});

test('fixPrompt safely repairs weak modals, legacy jargon, and non-loaded tool phrasing', () => {
  const dirtyPrompt = [
    '- Shell: harness `bash` only (`tool-pwsh` disabled). Launch `pwsh.exe` from `bash` when needed.',
    '- Bias toward action over speculation (no workflows, ralph, or delegation).'
  ].join('\n');

  const fixed = fixPrompt(dirtyPrompt, { activeTools: ['bash'] });

  assert.equal(fixed.includes('tool-pwsh'), false);
  assert.equal(fixed.includes('ralph'), false);
  assert.equal(fixed.includes('Bias toward'), false);
  assert.match(fixed, /Prioritize action over speculation/);
  assert.match(fixed, /- Shell: ONLY `bash`\. Launch `pwsh\.exe` from `bash` when needed\./);
});

test('lintPrompt returns 100 for clean high-signal prompt', () => {
  const cleanPrompt = [
    '# AUTONOMOUS AGENT CORE DIRECTIVE',
    '- Prioritize direct action over speculation: investigate via concurrent tools (fs, bash, skills) without orchestration overhead.',
    '- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.',
    '- Web: Research/fetch STRICTLY via skills (`agent-reach`, `gh`, `opencli-*`, `smart-search`) or bash CLIs.'
  ].join('\n');

  const result = lintPrompt(cleanPrompt, { activeTools: ['bash', 'read', 'write'] });
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
  assert.equal(result.fixesAvailable, false);
});

test('lintPromptFile handles missing and valid files gracefully', () => {
  const nonExistent = lintPromptFile('path/that/does/not/exist.md');
  assert.equal(nonExistent, null);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-linter-test-'));
  const testFile = path.join(tempDir, 'SYSTEM.md');
  fs.writeFileSync(testFile, '# Clean\n- STRICTLY follow rules.\n', 'utf8');

  const res = lintPromptFile(testFile, { activeTools: ['bash'] });
  assert.ok(res);
  assert.equal(res.score, 100);
  assert.equal(res.filePath, testFile);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('lintPrompt detects CLI require confusion', () => {
  const confusingPrompt = [
    '# Bad Directives',
    '- For browser testing, use `const { chromium } = require("playwright")`.'
  ].join('\n');

  const result = lintPrompt(confusingPrompt);
  assert.ok(result.issues.some(i => i.ruleId === PROMPT_LINT_RULES.CLI_REQUIRE_CONFUSION));
  assert.ok(result.score < 100);
});

test('fixPrompt preserves fenced code blocks and marks manual weak modals as non-fixable', () => {
  const prompt = [
    '- Please try to be concise.',
    '```md',
    '- must stay lowercase inside code fence',
    '- Bias toward keeping examples untouched',
    '```'
  ].join('\n');

  const linted = lintPrompt(prompt);
  const weakIssues = linted.issues.filter(i => i.ruleId === PROMPT_LINT_RULES.WEAK_MODALS);
  assert.ok(weakIssues.length >= 2);
  assert.ok(weakIssues.every(i => i.fixable === false));
  assert.equal(linted.fixesAvailable, false);

  const fixed = fixPrompt(prompt);
  assert.equal(fixed, prompt);
});
