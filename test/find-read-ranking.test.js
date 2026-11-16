import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReadWindows } from '../src/find-read-ranking.js';
import { createTestRuntime, call } from './support/runtime.js';

function file(path, rows) {
  return { displayPath: path, linePatterns: new Map(rows.map(([line, patterns]) => [line, new Set(patterns)])) };
}
const task = (file, start, end, matchedLines) => ({ file, win: { start, end, matchedLines } });

test('window selection favors combined pattern coverage over early duplicate calls', () => {
  const source = file('source.ts', [[1, ['a']], [30, ['a']], [100, ['a', 'b']]]);
  const chosen = selectReadWindows([task(source, 1, 3, [1]), task(source, 29, 31, [30]), task(source, 99, 101, [100])],
    { maxFiles: 1, maxWindows: 1, maxReadLines: 10 });
  assert.equal(chosen[0].win.start, 99);
});

test('window selection covers new patterns before redundant matches and respects maxFiles', () => {
  const a = file('a.ts', [[1, ['a', 'b']], [40, ['a']]]);
  const b = file('b.ts', [[1, ['c']]]);
  const c = file('c.ts', [[1, ['d']]]);
  const candidates = [task(a, 1, 3, [1]), task(a, 39, 41, [40]), task(b, 1, 3, [1]), task(c, 1, 3, [1])];
  const chosen = selectReadWindows(candidates, { maxFiles: 2, maxWindows: 3, maxReadLines: 9 });
  assert.deepEqual(chosen.map(item => item.file.displayPath), ['a.ts', 'b.ts', 'a.ts']);
  assert.equal(new Set(chosen.map(item => item.file)).size, 2);
});

test('window ranking penalizes costly duplicates and has stable path/line ties', () => {
  const a = file('a.ts', [[1, ['a']], [30, ['a']]]);
  const b = file('b.ts', [[1, ['a']]]);
  const candidates = [task(b, 1, 11, [1]), task(a, 29, 31, [30]), task(a, 1, 3, [1])];
  const options = { maxFiles: 2, maxWindows: 3, maxReadLines: 30 };
  const select = list => selectReadWindows(list, options).map(item => `${item.file.displayPath}:${item.win.start}`);
  assert.deepEqual(select(candidates), ['a.ts:1', 'a.ts:29', 'b.ts:1']);
  assert.deepEqual(select([...candidates].reverse()), select(candidates));
});

test('final shortened window targets uncovered patterns and retains exact aggregate line bounds', () => {
  const source = file('source.ts', [[1, ['a', 'c']], [100, ['a']], [110, ['b']]]);
  const chosen = selectReadWindows([task(source, 1, 3, [1]), task(source, 99, 112, [100, 110])],
    { maxFiles: 1, maxWindows: 2, maxReadLines: 5 });
  assert.deepEqual(chosen[0].win.matchedLines, [1]);
  assert.deepEqual(chosen[1].win.matchedLines, [110]);
  assert.equal(chosen.reduce((sum, item) => sum + item.win.end - item.win.start + 1, 0), 5);
});

test('official loop displays a later multi-pattern definition on the first read under a one-window budget', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => i === 0 ? 'import { alpha } from "./dependency";' : i === 100 ? 'export function alphaBeta() { return alpha + beta; }' : '// padding');
  const host = await createTestRuntime({
    files: { 'source.ts': lines.join('\n') },
    script: [[call('ranked-find', 'find_and_read', { patterns: ['alpha', 'beta'], contextLines: 2, maxWindows: 1 })], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Find alpha and beta implementation');
    const reads = host.calls.filter(item => item.name === 'read');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].args.offset, 99);
    const output = host.events.find(event => event.type === 'tool/result').data.message.content.map(block => block.text).join('\n');
    assert.match(output, /export function alphaBeta/);
    assert.match(output, /source\.ts: L1/);
  } finally { await host.dispose(); }
});
