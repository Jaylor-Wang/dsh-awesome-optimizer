import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCodeOutline, formatCodeOutline } from '../src/code-outline.js';
import { maskCode } from '../src/code-lexical.js';

const names = (source, filePath) => extractCodeOutline(source, { filePath }).map(entry => entry.text);

test('JS/TS outlines ignore multiline strings, nested templates, escaped quotes, regexes, and comments', () => {
  const source = [
    'const text = `',
    'export function fakeTemplate() {}',
    '${`nested ${"value"}`}',
    'export class FakeClass {}',
    '`;',
    '/* comment',
    'export function fakeComment() {}',
    '*/ export function realAfterComment() {}',
    'const regex = /[`"\\/]/g;',
    'const escaped = "quote\\\"text";',
    'export function realAfterStrings() {}'
  ].join('\n');
  assert.deepEqual(names(source, 'sample.ts'), ['export function realAfterComment()', 'export function realAfterStrings()']);
  const masked = maskCode(source, 'js');
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.equal(extractCodeOutline(source, { filePath: 'sample.ts' })[0].line, 8);
});

test('JS/TS outlines retain multiline functions, local arrows, generic arrows, and class methods', () => {
  const source = [
    'export async function real<T>(',
    '  value: T,',
    '  options = build({ nested: call(1) })',
    ') { return value; }',
    'const localArrow = (',
    '  arg: number',
    ') => arg;',
    'const identity = <T>(',
    '  arg: T',
    '): T => arg;',
    'const single = value => value;',
    'export class Worker {',
    '        async run(',
    '          task: string',
    '        ): Promise<void> {',
    '          if (task) { call(task); }',
    '        }',
    '}'
  ].join('\n');
  const entries = extractCodeOutline(source, { filePath: 'sample.ts' });
  assert.deepEqual(entries.map(entry => entry.line), [1, 5, 8, 11, 12, 13]);
  assert.match(entries[0].text, /function real\(value: T, options = build\(\{ nested: call\(1\) \}\)\)/);
  assert.match(entries[1].text, /const localArrow = \(arg: number\)/);
  assert.match(entries[2].text, /const identity = \(arg: T\)/);
  assert.equal(entries[3].text, 'const single = (value)');
  assert.equal(entries.at(-1).nested, true);
  assert.doesNotMatch(entries.map(entry => entry.text).join('\n'), /\bif\(/);
});

test('Python outlines ignore prefixed triple strings and support multiline decorators, classes, and Unicode names', () => {
  const source = [
    'text = rf"""',
    'def fake():',
    '    pass',
    '"""',
    '@decorator(',
    '    "value"',
    ')',
    'async def 处理(',
    '    item: str = "x",',
    '    callback = factory(1),',
    '):',
    '    return item',
    'class Worker(',
    '    Base,',
    '):',
    '        def run(',
    '            self, task',
    '        ):',
    '            return task'
  ].join('\r\n');
  const entries = extractCodeOutline(source, { filePath: 'worker.py' });
  assert.deepEqual(entries.map(entry => entry.line), [8, 13, 16]);
  assert.match(entries[0].text, /^async def 处理\(/);
  assert.equal(entries[1].text, 'class Worker(Base,)');
  assert.equal(entries[2].nested, true);
  assert.doesNotMatch(entries.map(entry => entry.text).join('\n'), /fake/);
});

test('Go outlines ignore raw strings and block comments while preserving multiline receiver functions', () => {
  const source = [
    'package example',
    'const text = `',
    'func Fake() {}',
    '`',
    '/* func FakeComment() {} */',
    'func (w *Worker) Run(',
    '    value string,',
    ') error { return nil }',
    'type Store[T any] struct {',
    '    value T',
    '}'
  ].join('\n');
  const entries = extractCodeOutline(source, { filePath: 'worker.go' });
  assert.deepEqual(entries.map(entry => entry.line), [6, 9]);
  assert.equal(entries[0].text, 'func (w *Worker) Run( value string, )');
  assert.equal(entries[1].text, 'type Store struct');
});

test('Rust outlines ignore raw literals and nested comments while preserving lifetimes and generic methods', () => {
  const source = [
    'const TEXT: &str = r##"',
    'pub fn fake() {}',
    '"##;',
    '/* outer /* inner */',
    'pub fn fakeComment() {}',
    '*/',
    'pub struct Worker;',
    "impl<'a> Worker {",
    '    pub async fn run<T>(',
    "        value: &'a T,",
    '    ) {}',
    '}'
  ].join('\n');
  const entries = extractCodeOutline(source, { filePath: 'worker.rs' });
  assert.deepEqual(entries.map(entry => entry.line), [7, 8, 9]);
  assert.match(entries[2].text, /pub async fn run<T>\( value: &'a T, \)/);
  assert.equal(entries[2].nested, true);
});

test('outline selection favors top-level exports and covers the far tail within byte and entry budgets', () => {
  const source = [
    'class PrivateWorker {',
    ...Array.from({ length: 30 }, (_, i) => `    method${i}() {}`),
    '}',
    ...Array.from({ length: 30 }, (_, i) => `export function api${i}() {}`)
  ].join('\n');
  const outline = formatCodeOutline(source, { filePath: 'sample.ts', maxEntries: 3, maxBytes: 256 });
  assert.match(outline, /api0/);
  assert.match(outline, /api29/);
  assert.doesNotMatch(outline, /method/);
  assert.equal(outline.split('\n').filter(line => /^L\d+/.test(line)).length, 3);
  assert.ok(Buffer.byteLength(outline) <= 256);
  const tail = formatCodeOutline(source, { filePath: 'sample.ts', startLine: 50, maxEntries: 3, maxBytes: 256 });
  assert.ok([...tail.matchAll(/^L(\d+)/gm)].every(match => Number(match[1]) >= 50));
});

test('bounded lexical headers tolerate incomplete declarations without fake entries or runaway signatures', () => {
  assert.deepEqual(names('export function incomplete(\n' + 'arg,\n'.repeat(3000), 'bad.ts'), []);
  assert.deepEqual(names('const text = `\nexport function fake() {}', 'bad.js'), []);
  assert.deepEqual(names('text = """\ndef fake():\n pass', 'bad.py'), []);
  const source = 'export function f(' + 'arg,'.repeat(3000) + ') {}';
  assert.deepEqual(names(source, 'bad.ts'), []);
  assert.deepEqual(names('export function incomplete;\nexport function real() {}', 'bad.ts'), ['export function real()']);
  assert.deepEqual(names('export function typed<T extends (arg: string) => void>(callback: T) {}', 'generic.ts'), ['export function typed(callback: T)']);
  assert.deepEqual(names('const local = function named(value) { return value; };', 'expression.js'), ['const local = (value)']);
});
