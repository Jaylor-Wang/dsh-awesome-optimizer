import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdaptiveOutline, needsAstOutline, parseAstEntries, runAstOutline } from '../src/ast-outline.js';
import { buildCodeOutline } from '../src/code-outline.js';
import { applyReadGuard } from '../src/read-guard.js';

const source = 'import React from "react";\nexport const Panel = () => <div>hello</div>;\nexport class Worker {\n  run(value: string) { return value; }\n}';

test('real ast-grep parses only stdin snapshots with correct one-based symbols and members', async () => {
  const result = await runAstOutline(source, 'not-a-local-file.tsx', { timeoutMs: 2000 });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.ok(result.entries.some(entry => entry.line === 2 && /Panel/.test(entry.text)));
  assert.ok(result.entries.some(entry => entry.line === 3 && /Worker/.test(entry.text)));
  assert.ok(result.entries.some(entry => entry.line === 4 && /run/.test(entry.text) && entry.nested));
  assert.ok(!result.entries.some(entry => /import React/.test(entry.text)));
});

test('auto mode avoids CLI for ordinary files and uses it only for known lexical gaps', async () => {
  const simple = 'export function ordinary() {}';
  const lexical = await buildAdaptiveOutline(simple, 'ordinary.ts', { astGrepCommand: 'missing-command-for-test' });
  assert.equal(lexical.engine, 'lexical');
  assert.equal(lexical.astStatus, undefined);
  assert.equal(needsAstOutline(source, 'panel.tsx', buildCodeOutline(source, 'panel.tsx'), 'auto'), true);
  assert.equal(needsAstOutline(simple, 'ordinary.ts', buildCodeOutline(simple, 'ordinary.ts'), 'off'), false);
  const ast = await buildAdaptiveOutline(source, 'panel.tsx', { astTimeoutMs: 2000 });
  assert.equal(ast.engine, 'ast');
});

test('AST removes fake declarations in JSX text and exposes namespace members missed by lexical scanning', async () => {
  const jsx = 'export const View = () => <section>\nexport function fakeInText() {}\n</section>;\nexport function real() {}';
  const parsed = await buildAdaptiveOutline(jsx, 'view.tsx', { astTimeoutMs: 2000 });
  assert.equal(parsed.engine, 'ast');
  assert.ok(parsed.entries.some(entry => /real/.test(entry.text)));
  assert.ok(!parsed.entries.some(entry => /fakeInText/.test(entry.text)));
  const namespace = 'export namespace API {\n  export function run(value: string) { return value; }\n}';
  const nested = await buildAdaptiveOutline(namespace, 'api.ts', { astTimeoutMs: 2000 });
  assert.equal(nested.engine, 'ast');
  assert.ok(nested.entries.some(entry => /API/.test(entry.text)));
  assert.ok(nested.entries.some(entry => /run/.test(entry.text) && entry.nested));
});

test('explicit AST mode supports all five outline language families', async () => {
  const fixtures = [
    ['sample.js', 'export function sample() {}'],
    ['sample.ts', 'export function sample<T>(value: T) { return value; }'],
    ['sample.py', 'def sample(value):\n    return value'],
    ['sample.go', 'package sample\nfunc Sample() {}'],
    ['sample.rs', 'pub fn sample() {}']
  ];
  for (const [filePath, content] of fixtures) {
    const parsed = await buildAdaptiveOutline(content, filePath, { astOutline: 'always', astTimeoutMs: 2000 });
    assert.equal(parsed.engine, 'ast', `${filePath}: ${parsed.astStatus}`);
    assert.ok(parsed.entries.some(entry => /sample/i.test(entry.text)), filePath);
  }
});

test('missing executable and deadline fall back to lexical results', async () => {
  const missing = await buildAdaptiveOutline(source, 'panel.tsx', { astGrepCommand: 'missing-ast-grep-executable-for-tests' });
  assert.equal(missing.astStatus, 'unavailable');
  assert.equal(missing.engine, 'lexical');
  assert.ok(missing.entries.length);
  const limited = await runAstOutline(source, 'panel.tsx', { timeoutMs: 1 });
  assert.equal(limited.status, 'timeout');
});

test('CLI output limits and cancellation terminate optional parsing', async () => {
  const huge = Array.from({ length: 500 }, (_, i) => `export function symbol${i}() {}`).join('\n');
  const result = await runAstOutline(huge, 'huge.ts', { maxOutputBytes: 1024, timeoutMs: 2000 });
  assert.equal(result.status, 'output-limit');
  const controller = new AbortController();
  const pending = runAstOutline(huge, 'huge.ts', { timeoutMs: 2000, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, 'aborted');
  assert.equal((await runAstOutline(source, 'panel.tsx', { signal: controller.signal })).status, 'aborted');
});

test('malformed structural output is rejected rather than reported as a complete outline', () => {
  assert.throws(() => parseAstEntries({}, 10));
  assert.throws(() => parseAstEntries([{ items: [{ signature: 'bad', range: { start: { line: 100 } } }] }], 10));
});

test('readGuard caches AST success and failed attempts by version and honors off mode', async () => {
  for (const mode of ['success', 'missing', 'off']) {
    const hooks = new Map();
    const session = {};
    let reads = 0;
    let version = 'v1';
    const fs = {
      resolve: async () => ({ targetKey: 'virtual:panel' }),
      stat: async () => ({ type: 'file', size: Buffer.byteLength(source), version }),
      readBytes: async () => { reads++; return Buffer.from(source); }
    };
    const guard = applyReadGuard({
      on(name, callback) { hooks.set(name, callback); },
      get(name) { return name === 'fs' ? fs : undefined; }
    }, { astOutline: mode === 'off' ? 'off' : 'auto', astGrepCommand: mode === 'missing' ? 'missing-ast-grep-test' : 'ast-grep', astTimeoutMs: 2000 });
    const inspect = async () => {
      const result = { content: [{ type: 'text', text: '<content>\n1: import\n\n(Showing lines 1-1 of 5. Use offset=2 to continue.)\n</content>' }] };
      return hooks.get('tools/post-execute')({ name: 'read', arguments: { file_path: 'virtual-panel.tsx' }, agent: { session } }, result, async () => undefined);
    };
    await inspect(); await inspect();
    assert.equal(reads, 1);
    assert.equal(guard.getStats(session).outlineCacheHits, 1);
    assert.equal(guard.getStats(session).outlineCacheLookups, 2);
    assert.equal(guard.getStats(session).outlineCacheMisses, 1);
    assert.equal(guard.getStats(session).outlineCacheHitRate, 0.5);
    assert.equal(guard.getStats(session).astAttempts, mode === 'off' ? 0 : 1);
    assert.equal(guard.getStats(session).astSucceeded, mode === 'success' ? 1 : 0);
    assert.equal(guard.getStats(session).astFallbacks, mode === 'missing' ? 1 : 0);
    version = 'v2';
    await inspect();
    assert.equal(reads, 2);
    assert.equal(guard.getStats(session).astAttempts, mode === 'off' ? 0 : 2);
  }
});
