import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReadWindows } from '../src/find-read-ranking.js';
import { createTestRuntime, call } from './support/runtime.js';

function file(path, rows) {
  return {
    displayPath: path,
    linePatterns: new Map(rows.map(([line, patterns]) => [line, new Set(patterns)])),
    lines: new Map(rows.map(([line, , text]) => [line, text ?? '']))
  };
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

test('a single file slot goes to the file whose feasible windows cover more patterns', async () => {
  const contents = entries => Array.from({ length: 20 }, (_, i) => entries[i + 1] ?? '// padding').join('\n');
  const host = await createTestRuntime({
    files: {
      'a.ts': contents({ 5: 'alpha beta' }),
      'b.ts': contents({ 5: 'alpha beta', 15: 'gamma delta' })
    },
    script: [[call('one-file', 'find_and_read', {
      patterns: ['alpha', 'beta', 'gamma', 'delta'], contextLines: 1, maxFiles: 1, maxWindows: 2
    })], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Find all four markers');
    const reads = host.calls.filter(item => item.name === 'read');
    assert.deepEqual(reads.map(item => [item.args.file_path, item.args.offset]), [['b.ts', 4], ['b.ts', 14]]);
    const output = host.events.find(event => event.type === 'tool/result').data.message.content[0].text;
    assert.match(output, /^> 5: alpha beta$/m);
    assert.match(output, /^> 15: gamma delta$/m);
    assert.match(output, /a\.ts: L5/);
  } finally { await host.dispose(); }
});

test('single-file lookahead respects the total line budget', () => {
  const a = file('a.ts', [[3, ['a', 'b']]]);
  const b = file('b.ts', [[10, ['a', 'b']], [19, ['c']]]);
  const chosen = selectReadWindows([
    task(a, 2, 4, [3]), task(b, 9, 11, [10]), task(b, 18, 20, [19])
  ], { maxFiles: 1, maxWindows: 2, maxReadLines: 3 });
  assert.deepEqual(chosen.map(item => item.file.displayPath), ['a.ts']);
});

test('single-file plans prefer declarations only after distinct pattern coverage', () => {
  const refs = file('a.js', [[1, ['alpha'], 'alpha();'], [9, ['beta'], 'beta();']]);
  const defs = file('b.ts', [[5, ['alpha'], 'export async function alpha() {}'], [20, ['beta'], 'export default function* beta() {}']]);
  const candidates = [task(refs, 1, 1, [1]), task(refs, 9, 9, [9]), task(defs, 4, 6, [5]), task(defs, 19, 21, [20])];
  const limits = { maxFiles: 1, maxWindows: 2, maxReadLines: 6 };
  assert.deepEqual(selectReadWindows(candidates, limits).map(item => item.file.displayPath), ['b.ts', 'b.ts']);
  assert.deepEqual(selectReadWindows(candidates, { ...limits, maxReadLines: 2 }).map(item => item.file.displayPath), ['a.js', 'a.js']);
});

test('a declaration plan can displace combined imports without losing query coverage', () => {
  const refs = file('a.js', [[1, ['alpha', 'beta'], 'import { alpha, beta } from "./b.js";']]);
  const defs = file('b.js', [[5, ['alpha'], 'function alpha() {}'], [20, ['beta'], 'function beta() {}']]);
  const candidates = [task(refs, 1, 1, [1]), task(defs, 4, 6, [5]), task(defs, 19, 21, [20])];
  const limits = { maxFiles: 2, maxWindows: 2, maxReadLines: 6 };
  assert.deepEqual(selectReadWindows(candidates, limits).map(({ win }) => win.start), [4, 19]);
  assert.deepEqual(selectReadWindows(candidates, { ...limits, maxWindows: 1 }).map(({ win }) => win.start), [1]);
  const different = file('c.js', [[25, ['gamma', 'delta'], 'function gamma() { return delta; }']]);
  assert.deepEqual(selectReadWindows([candidates[0], task(different, 24, 26, [25])], { ...limits, maxWindows: 1 })
    .map(({ win }) => win.start), [1]);
});

test('declaration ties apply to shortened windows but never replace a new pattern', () => {
  const source = file('a.js', [[1, ['foo', 'bar']], [8, ['foo'], 'foo();'], [9, ['foo'], 'function foo() {}'], [13, ['foo'], 'function foo() {}'], [16, ['baz'], 'baz();']]);
  const scarce = [task(source, 1, 1, [1]), task(source, 8, 9, [8, 9])];
  const limits = { maxFiles: 1, maxWindows: 3, maxReadLines: 2 };
  assert.deepEqual(selectReadWindows(scarce, limits).map(({ win }) => win.matchedLines), [[1], [9]]);
  const more = [...scarce, task(source, 13, 13, [13]), task(source, 16, 16, [16])];
  assert.deepEqual(selectReadWindows(more, { ...limits, maxReadLines: 4 }).map(({ win }) => win.matchedLines), [[1], [16], [13]]);
});

test('generic regexes, non-source files, and non-declarations keep the normal order', () => {
  for (const [path, pattern, declaration] of [
    ['b.js', 'foo.*', 'function foo() {}'],
    ['b.js', 'foo', 'function foobar() {}'],
    ['b.js', 'foo', '// function foo() {}'],
    ['b.js', 'foo', 'import { foo } from "./other.js";'],
    ['b.d.mts', 'foo', 'function foo(): void;'],
    ['b.md', 'foo', 'function foo() {}']
  ]) {
    const a = file('a.js', [[1, [pattern], 'foo();']]);
    const b = file(path, [[1, [pattern], declaration]]);
    assert.equal(selectReadWindows([task(b, 1, 1, [1]), task(a, 1, 1, [1])], { maxFiles: 1, maxWindows: 1, maxReadLines: 1 })[0].file, a);
  }
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

test('declaration ranking supports TS classes/arrows and Python, Go, and Rust declarations', () => {
  const cases = [
    ['ref.ts', 'const x = new PolicyEngine();', 'def.ts', 'PolicyEngine', 'export class PolicyEngine {'],
    ['ref.ts', 'const y = computeScore(1);', 'def.ts', 'computeScore', 'export const computeScore = (n: number) => n * 2;'],
    ['ref.ts', 'const z = buildItem();', 'def.ts', 'buildItem', 'export const buildItem = (a = make(1)): number => a;'],
    ['ref.py', 'result = build_index(items)', 'def.py', 'build_index', 'async def build_index(items):'],
    ['ref.go', 'worker.RunTask(ctx)', 'def.go', 'RunTask', 'func (w *Worker) RunTask(ctx Context) error {'],
    ['ref.rs', 'let s = parse_frame(buf);', 'def.rs', 'parse_frame', 'pub async fn parse_frame(buf: &[u8]) -> Frame {'],
    ['ref.rs', 'let cfg = EngineConfig::default();', 'def.rs', 'EngineConfig', 'pub struct EngineConfig {']
  ];
  for (const [refPath, refLine, defPath, symbol, defLine] of cases) {
    const refs = file(refPath, [[1, [symbol], refLine]]);
    const defs = file(defPath, [[10, [symbol], defLine]]);
    const chosen = selectReadWindows(
      [task(refs, 1, 1, [1]), task(defs, 9, 11, [10])],
      { maxFiles: 1, maxWindows: 1, maxReadLines: 3 }
    );
    assert.equal(chosen[0].file.displayPath, defPath, `Expected ${defPath} declaration to beat ${refPath} for ${symbol}`);
  }

  // Non-arrow parenthesized assignments and indented local const mocks must NOT be treated as declarations
  for (const [symbol, falseDecl] of [
    ['total', 'const total = (a + b) * c;'],
    ['payload', 'const payload = (await fetch(url));'],
    ['cfg', 'const cfg = ({ retries: 3 });'],
    ['verifyToken', '  const verifyToken = () => true;']
  ]) {
    const a = file('a.ts', [[1, [symbol], `use(${symbol});`]]);
    const b = file('b.ts', [[1, [symbol], falseDecl]]);
    const chosen = selectReadWindows(
      [task(b, 1, 1, [1]), task(a, 1, 1, [1])],
      { maxFiles: 1, maxWindows: 1, maxReadLines: 1 }
    );
    assert.equal(chosen[0].file, a, `False declaration "${falseDecl}" must not outrank a.ts`);
  }
});

test('multiline unclosed arrow declaration headers never cause catastrophic regex backtracking', () => {
  const unclosed = 'export const handleUserAuthenticationRequest = (requestContext, sessionOptions, retryPolicy, auditSink, extraArgName,';
  const a = file('a.ts', [[1, ['handleUserAuthenticationRequest'], 'handleUserAuthenticationRequest();']]);
  const b = file('b.ts', [[1, ['handleUserAuthenticationRequest'], unclosed]]);
  const started = performance.now();
  const chosen = selectReadWindows(
    [task(b, 1, 1, [1]), task(a, 1, 1, [1])],
    { maxFiles: 1, maxWindows: 1, maxReadLines: 1 }
  );
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 250, `Expected linear-time matching (<250ms), took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(chosen[0].file, a);
});
