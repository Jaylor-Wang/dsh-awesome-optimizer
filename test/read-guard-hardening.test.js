import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestRuntime, call } from './support/runtime.js';
import { applyReadGuard, extractCodeOutline, formatCodeOutline } from '../src/read-guard.js';
import { OutlineCache } from '../src/outline-cache.js';

const tailContent = 'head\nexport function hiddenTail() {}';
const truncated = '<content>\n1: head\n\n(Showing lines 1-1 of 2. Use offset=2 to continue.)\n</content>';

async function inspect({ filePath = 'target.ts', files, configure, maxInspectBytes = 4096 }, check) {
  const counters = { resolve: 0, stat: 0, reads: 0, readText: 0 };
  const host = await createTestRuntime({
    files: files ?? { [filePath]: tailContent },
    optimizerConfig: { readGuard: { maxInspectBytes } },
    configureTools(ctx) {
      const service = ctx.get('fs');
      const resolve = service.resolve.bind(service);
      const stat = service.stat.bind(service);
      service.resolve = async (...args) => { counters.resolve++; return resolve(...args); };
      service.stat = async (...args) => { counters.stat++; return stat(...args); };
      service.readBytes = async (_target, _signal, maxBytes) => {
        counters.reads++;
        assert.equal(maxBytes, maxInspectBytes);
        return Buffer.from(tailContent);
      };
      service.readText = async () => { counters.readText++; return tailContent; };
      configure?.(service, counters);
    },
    readHandler: () => truncated,
    script: [[call('guard-boundary', 'read', { file_path: filePath })], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Verify bounded optional outline reads');
    const result = host.events.find(event => event.type === 'tool/result');
    assert.ok(result);
    assert.equal(result.data.message.isError, false);
    const output = result.data.message.content.map(block => block.text).join('\n');
    await check({ counters, output, host });
  } finally { await host.dispose(); }
}

test('readGuard skips unsupported and extensionless files before resolve, stat, or content reads', async () => {
  for (const filePath of ['large.json', 'Makefile', 'CHANGELOG']) {
    await inspect({ filePath }, ({ counters, output }) => {
      assert.deepEqual(counters, { resolve: 0, stat: 0, reads: 0, readText: 0 });
      assert.equal(output, truncated);
    });
  }
  assert.deepEqual(extractCodeOutline('all:\n\techo hi\n', { filePath: 'Makefile' }), []);
  assert.deepEqual(
    extractCodeOutline('#!/usr/bin/env python3\ndef cli_main():\n    pass\n', { filePath: 'bin/tool' }).map(e => e.text),
    ['def cli_main()']
  );
  assert.deepEqual(
    extractCodeOutline('export function defaultJs() {}\n').map(e => e.text),
    ['export function defaultJs()']
  );
});

test('readGuard rejects known oversized, absent, non-file, and unknown-size targets before reads', async () => {
  for (const info of [undefined, { type: 'file', size: 5000 }, { type: 'directory', size: 1 }, { type: 'file' }, { type: 'file', size: -1 }]) {
    await inspect({ configure(service, counters) { service.stat = async () => { counters.stat++; return info; }; } },
      ({ counters, output, host }) => {
        assert.equal(counters.reads, 0);
        assert.equal(counters.readText, 0);
        assert.equal(output, truncated);
        const stats = host.readGuard.getStats(host.agent.session);
        assert.equal(stats.outlineCacheLookups, 0);
        assert.equal(stats.outlineCacheBypasses, 0);
        assert.equal(stats.outlineCacheHitRate, null);
      });
  }
});

test('readGuard uses the bounded byte seam after preflight and preserves the read wrapper', async () => {
  await inspect({}, ({ counters, output }) => {
    assert.equal(counters.resolve, 1);
    assert.equal(counters.stat, 2); // Preflight plus post-read version validation.
    assert.equal(counters.reads, 1);
    assert.equal(counters.readText, 0);
    assert.match(output, /Remaining file outline/);
    assert.match(output, /L2: export function hiddenTail/);
    assert.match(output, /<\/content>$/);
  });
});

test('readGuard never falls through service failures to readText or local disk', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outline-access-'));
  const target = path.join(tempDir, 'available.ts');
  fs.writeFileSync(target, tailContent, 'utf8');
  try {
    for (const stage of ['resolve', 'stat', 'readBytes']) {
      for (const code of ['EACCES', 'ENOENT', 'ABORT_ERR']) {
        await inspect({
          filePath: target,
          configure(service) { service[stage] = async () => { throw Object.assign(new Error(code), { code }); }; }
        }, ({ counters, output }) => {
          assert.equal(output, truncated);
          assert.equal(counters.readText, 0);
        });
      }
    }
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('readGuard refuses oversized or invalid UTF-8 responses from byte backends', async () => {
  for (const bytes of [Buffer.alloc(4097, 97), Buffer.from([0xff])]) {
    await inspect({ configure(service) { service.readBytes = async () => bytes; } }, ({ counters, output }) => {
      assert.equal(counters.readText, 0);
      assert.equal(output, truncated);
    });
  }
});

test('readGuard supports bounded text streaming and closes an over-limit stream', async () => {
  let closed = false;
  let chunks = 0;
  await inspect({ configure(service) {
    delete service.readBytes;
    service.streamText = async () => (async function* () {
      try {
        chunks++; yield 'x'.repeat(2048);
        chunks++; yield 'x'.repeat(2049);
        chunks++; yield tailContent;
      } finally { closed = true; }
    })();
  } }, ({ counters, output }) => {
    assert.equal(closed, true);
    assert.equal(chunks, 2);
    assert.equal(counters.readText, 0);
    assert.equal(output, truncated);
  });
  await inspect({ configure(service) {
    delete service.readBytes;
    service.streamText = async () => (async function* () { yield 'head\n'; yield 'export function hiddenTail() {}'; })();
  } }, ({ output }) => assert.match(output, /L2: export function hiddenTail/));
});

test('readGuard honors cancellation between stat and content reads', async () => {
  const controller = new AbortController();
  let hook;
  let reads = 0;
  const service = {
    resolve: async () => ({}),
    stat: async () => { controller.abort(); return { type: 'file', size: 20 }; },
    readBytes: async () => { reads++; return Buffer.from(tailContent); }
  };
  applyReadGuard({
    on(name, callback) { if (name === 'tools/post-execute') hook = callback; },
    get(name) { return name === 'fs' ? service : undefined; }
  });
  const result = { content: [{ type: 'text', text: truncated }] };
  const decision = await hook({ name: 'read', arguments: { file_path: 'target.ts' }, signal: controller.signal }, result, async () => undefined);
  assert.equal(reads, 0);
  assert.equal(decision, undefined);
  assert.equal(result.content[0].text, truncated);
});

test('standalone local inspections bypass caching and reject reads after disposal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outline-local-'));
  const target = path.join(tempDir, 'source.ts');
  fs.writeFileSync(target, tailContent, 'utf8');
  const hooks = new Map();
  const session = {};
  const guard = applyReadGuard({
    on(name, callback) { hooks.set(name, callback); },
    get() { return undefined; }
  });
  const run = () => hooks.get('tools/post-execute')({
    name: 'read', arguments: { file_path: target }, agent: { session }
  }, { content: [{ type: 'text', text: truncated }] }, async () => undefined);
  try {
    assert.match((await run()).content[0].text, /hiddenTail/);
    assert.match((await run()).content[0].text, /hiddenTail/);
    const stats = guard.getStats(session);
    assert.equal(stats.outlineCacheLookups, 0);
    assert.equal(stats.outlineCacheBypasses, 2);
    assert.equal(stats.outlineCacheHitRate, null);
    hooks.get('session/disposed')(session);
    assert.equal(await run(), undefined);
  } finally {
    hooks.get('dispose')();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readGuard preflights legacy readText and never reads a known oversized file', async () => {
  await inspect({ configure(service) { delete service.readBytes; } }, ({ counters, output }) => {
    assert.equal(counters.stat, 2); // Legacy reads also validate the version after reading.
    assert.equal(counters.readText, 1);
    assert.match(output, /hiddenTail/);
  });
  await inspect({ files: { 'target.ts': 'x'.repeat(4097) }, configure(service) { delete service.readBytes; } }, ({ counters, output }) => {
    assert.equal(counters.readText, 0);
    assert.equal(output, truncated);
  });
});

test('readGuard subpath exports code outline helpers, keeps getStats side-effect-free, and never leaks caches when ctx.get("fs") throws', async t => {
  assert.equal(typeof extractCodeOutline, 'function');
  assert.equal(typeof formatCodeOutline, 'function');
  assert.match(formatCodeOutline('export function ping() {}\n', { filePath: 'demo.ts' }), /export function ping/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-read-guard-fs-throw-'));
  const target = path.join(tempDir, 'secret.ts');
  fs.writeFileSync(target, tailContent, 'utf8');

  const cleared = [];
  const originalClear = OutlineCache.prototype.clear;
  t.mock.method(OutlineCache.prototype, 'clear', function () {
    originalClear.call(this);
    cleared.push(this);
  });

  const hooks = new Map();
  const session = {};
  const unseenSession = {};
  const guard = applyReadGuard({
    on(name, callback) { hooks.set(name, callback); },
    get(name) {
      if (name === 'fs') throw new Error('fs service unavailable');
      return undefined;
    }
  });
  try {
    // Querying stats on an unseen session must not throw or leave side effects
    const initial = guard.getStats(unseenSession);
    assert.equal(initial.inspected, 0);
    assert.equal(initial.outlineCacheHitRate, null);

    for (let i = 0; i < 10; i++) {
      const decision = await hooks.get('tools/post-execute')(
        { name: 'read', arguments: { file_path: target }, agent: { session } },
        { content: [{ type: 'text', text: truncated }] },
        async () => undefined
      );
      assert.equal(decision, undefined);
    }
    hooks.get('dispose')();
    assert.equal(cleared.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
