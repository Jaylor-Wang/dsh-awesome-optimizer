import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { CacheDiagnostics } from '../src/cache-diagnostics.js';
import { applyTelemetry } from '../src/telemetry.js';
import { createTestRuntime, call } from './support/runtime.js';

test('atomic batch rejects identical and empty old strings before any edit dispatch', async () => {
  for (const old of ['same', '']) {
    const host = await createTestRuntime({
      files: { 'a.txt': 'first', 'b.txt': 'same' },
      configureTools(ctx, { virtualFs }) {
        ctx.get('fs').readFile = async filePath => virtualFs.get(filePath);
      },
      script: [
        [call('invalid-batch', 'edit_batch', { atomic: true, edits: [
          { file_path: 'a.txt', old_string: 'first', new_string: 'changed' },
          { file_path: 'b.txt', old_string: old, new_string: 'same' }
        ] })], [{ type: 'text', text: 'done' }]
      ]
    });
    try {
      await host.run('Validate atomic preflight');
      const result = host.events.find(event => event.type === 'tool/result').data.message;
      assert.equal(result.isError, true);
      const output = result.content.map(block => block.text).join('\n');
      assert.match(output, /\[ERROR\] b\.txt ===\n\[ERROR\] Invalid edit entry: old_string must be non-empty and differ from new_string\./);
      assert.equal(host.calls.filter(c => c.name === 'edit').length, 0);
      assert.equal(host.virtualFs.get('a.txt'), 'first');
      assert.equal(host.virtualFs.get('b.txt'), 'same');
      assert.equal(host.compositeTools.getStats(host.agent.session).editsFailed, 2);
    } finally { await host.dispose(); }
  }
});

test('diagnostic initialization failure leaves telemetry enabled', () => {
  const hooks = [];
  const warnings = [];
  const manager = applyTelemetry({ on: (name, fn) => hooks.push([name, fn]), logger: { warn: msg => warnings.push(msg) } }, { cacheDiagnosticsPath: 'relative-path' });
  assert.ok(manager);
  assert.equal(warnings.length, 1);
  assert.equal(hooks.filter(([name]) => name === 'llm/stream').length, 1);
});

test('diagnostic queue is bounded, drains on disposal and reports failures once', async () => {
  const warnings = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const output = [];
  const observer = new CacheDiagnostics(path.join(os.tmpdir(), 'optimizer-fake-writer.jsonl'), {
    maxQueuedBytes: 160,
    onStop: reason => warnings.push(reason),
    writer: async (_file, line) => { await gate; output.push(JSON.parse(line)); }
  });
  observer.emit({ type: 'one' });
  observer.emit({ type: 'two' });
  observer.emit({ type: 'large', data: 'x'.repeat(200) });
  observer.emit({ type: 'after-stop' });
  assert.deepEqual(warnings, ['queue-size-limit']);
  assert.equal(output.length, 0);
  release();
  await observer.dispose();
  assert.deepEqual(output.map(r => r.type), ['one', 'two']);
  assert.equal(observer.queuedBytes, 0);
  const failed = new CacheDiagnostics(path.join(os.tmpdir(), 'optimizer-fake-writer.jsonl'), {
    onStop: reason => warnings.push(reason), writer: async () => { throw new Error('disk unavailable'); }
  });
  failed.emit({ type: 'one' });
  await failed.flush();
  failed.emit({ type: 'two' });
  await failed.dispose();
  assert.deepEqual(warnings, ['queue-size-limit', 'write-failed']);
  const cappedRecords = [];
  const capped = new CacheDiagnostics(null, { sink: record => cappedRecords.push(record), maxBytes: 1, onStop: r => warnings.push(r) });
  capped.emit({ type: 'one' });
  capped.emit({ type: 'two' });
  await capped.dispose();
  assert.deepEqual(cappedRecords, []);
  assert.equal(capped.bytes, 0);
  assert.equal(warnings.at(-1), 'file-size-limit');
  assert.equal(warnings.length, 3);
});
