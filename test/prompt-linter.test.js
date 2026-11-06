import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lintPrompt, fixPrompt, lintPromptFile, PROMPT_LINT_RULES } from '../src/index.js';

test('lintPrompt detects deprecated tools, weak modals, and unclosed backticks', () => {
  const dirtyPrompt = [
    '# Bad Prompt',
    '- Shell: harness `bash` only (`tool-pwsh` disabled). Launch `pwsh.exe` from `bash` when needed.',
    '- Web: harness `web-search-deepseek` is disabled.',
    '- Bias toward action over speculation (no workflows, ralph, or delegation).',
    '- Please try to follow this rule.',
    '- This line has an unclosed `backtick.'
  ].join('\n');

  const result = lintPrompt(dirtyPrompt);

  assert.ok(result.score < 80, `Expected score to drop due to multiple issues, got ${result.score}`);
  assert.ok(result.issues.length >= 5);
  assert.equal(result.fixesAvailable, true);

  const ruleIds = result.issues.map(i => i.ruleId);
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.DEPRECATED_TOOLS));
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.WEAK_MODALS));
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.LEGACY_JARGON));
  assert.ok(ruleIds.includes(PROMPT_LINT_RULES.UNCLOSED_BACKTICKS));
});

test('fixPrompt safely repairs weak modals, legacy jargon, and deprecated tool phrasing', () => {
  const dirtyPrompt = [
    '- Shell: harness `bash` only (`tool-pwsh` disabled). Launch `pwsh.exe` from `bash` when needed.',
    '- Bias toward action over speculation (no workflows, ralph, or delegation).'
  ].join('\n');

  const fixed = fixPrompt(dirtyPrompt);

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

  const result = lintPrompt(cleanPrompt);
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

  const res = lintPromptFile(testFile);
  assert.ok(res);
  assert.equal(res.score, 100);
  assert.equal(res.filePath, testFile);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
