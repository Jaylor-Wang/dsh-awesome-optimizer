import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReadGuard } from '../src/read-guard.js';
import { OutlineCache } from '../src/outline-cache.js';

function fixture(config = {}) {
  const hooks = new Map();
  let content = 'head\nexport function one() {}\nexport function two() {}';
  let version = 'v1';
  let key = '/repo/source.ts';
  let readCount = 0;
  let statCount = 0;
  const session = {};
  const service = {
    resolve: async () => ({ targetKey: key }),
    stat: async () => { statCount++; return { type: 'file', size: Buffer.byteLength(content), version }; },
    readBytes: async (_target, _signal, cap) => { readCount++; assert.ok(Buffer.byteLength(content) <= cap); return Buffer.from(content); }
  };
  let backend = service;
  const ctx = {
    on(name, callback) { hooks.set(name, callback); },
    get(name) { return name === 'fs' ? backend : undefined; }
  };
  const guard = applyReadGuard(ctx, config);
  const inspect = async (endLine = 1, currentSession = session, filePath = 'source.ts') => {
    const text = `<content>\n1: head\n\n(Showing lines 1-${endLine} of 3. Use offset=${endLine + 1} to continue.)\n</content>`;
    const result = { content: [{ type: 'text', text }] };
    const decision = await hooks.get('tools/post-execute')({ name: 'read', arguments: { file_path: filePath }, agent: { session: currentSession }, signal: new AbortController().signal }, result, async () => undefined);
    return decision?.content?.[0]?.text ?? text;
  };
  return {
    hooks, service, session, inspect, guard,
    reads: () => readCount, stats: () => statCount,
    useBackend(next) { backend = next; },
    change(nextContent, nextVersion = version, nextKey = key) { content = nextContent; version = nextVersion; key = nextKey; },
    mutate: name => hooks.get('tools/post-execute')({ name, agent: { session } }, {}, async () => undefined)
  };
}

test('version cache avoids content reads and re-filters symbols for each native truncation offset', async () => {
  const host = fixture();
  assert.match(await host.inspect(), /L2: export function one/);
  const second = await host.inspect(2);
  assert.doesNotMatch(second, /L2:/);
  assert.match(second, /L3: export function two/);
  assert.equal(host.reads(), 1);
  assert.equal(host.stats(), 3);
  await host.hooks.get('session/event')(host.session, { type: 'turn/start' });
  await host.inspect();
  assert.equal(host.reads(), 1);
});

test('changed version, resolved identity, language, or session never reuses another outline', async () => {
  const host = fixture();
  await host.inspect();
  host.change('head\nexport function newVersion() {}', 'v2');
  assert.match(await host.inspect(), /newVersion/);
  host.change('head\nexport function otherIdentity() {}', 'v2', '/other/source.ts');
  assert.match(await host.inspect(), /otherIdentity/);
  await host.inspect(1, {});
  host.change('head\ndef python():\n pass', 'v2');
  assert.match(await host.inspect(1, host.session, 'source.py'), /def python/);
  assert.equal(host.reads(), 5);
});

test('unversioned services and disabled caches read again', async () => {
  for (const disable of [false, true]) {
    const host = fixture(disable ? { maxCacheEntries: 0 } : {});
    if (!disable) host.change('head\nexport function fresh() {}', undefined);
    // Explicitly remove version because change() defaults omitted values.
    if (!disable) host.service.stat = async () => ({ type: 'file', size: 36 });
    await host.inspect(); await host.inspect();
    assert.equal(host.reads(), 2);
  }
});

test('cache cannot hide stat denial or survive local mutations', async () => {
  const host = fixture();
  await host.inspect();
  const originalStat = host.service.stat;
  host.service.stat = async () => { throw new Error('EACCES'); };
  assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
  host.service.stat = originalStat;
  for (const name of ['edit', 'write', 'edit_batch', 'bash', 'eval_node', 'eval_python']) {
    await host.mutate(name);
    await host.inspect();
  }
  assert.equal(host.reads(), 7);
  const stats = host.guard.getStats(host.session);
  assert.equal(stats.outlineCacheLookups, 7);
  assert.equal(stats.outlineCacheMisses, 7);
  assert.equal(stats.outlineCacheInvalidations, 6);
});

test('cache rejects a version race and invalidation during an in-flight read', async () => {
  const host = fixture();
  const read = host.service.readBytes;
  host.service.readBytes = async (...args) => {
    const content = await read(...args);
    host.change('head\nexport function changed() {}', 'v2');
    return content;
  };
  assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
  host.service.readBytes = read;
  assert.match(await host.inspect(), /changed/);
  assert.equal(host.reads(), 2);
  await host.mutate('edit');
  host.service.readBytes = async (...args) => { const content = await read(...args); await host.mutate('edit'); return content; };
  assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
});

test('cache accounting separates lookups, hits, misses, bypasses, and detached per-turn snapshots', async () => {
  const host = fixture();
  assert.equal(host.guard.getStats(host.session).outlineCacheHitRate, null);
  await host.inspect();
  const first = host.guard.getStats(host.session);
  assert.equal(first.outlineCacheLookups, 1);
  assert.equal(first.outlineCacheMisses, 1);
  assert.equal(first.outlineCacheHitRate, 0);
  await host.inspect();
  const second = host.guard.getStats(host.session);
  assert.equal(second.outlineCacheLookups, 2);
  assert.equal(second.outlineCacheHits, 1);
  assert.equal(second.outlineCacheHitRate, 0.5);
  assert.equal(first.outlineCacheHits, 0);
  second.outlineCacheHits = 99;
  assert.equal(host.guard.getStats(host.session).outlineCacheHits, 1);
  host.change('head\nexport function changed() {}', 'v2');
  await host.inspect();
  const changed = host.guard.getStats(host.session);
  assert.equal(changed.outlineCacheMisses, 2);
  assert.equal(changed.outlineCacheLookups, changed.outlineCacheHits + changed.outlineCacheMisses);
  assert.equal(changed.outlineCacheHitRate, 1 / 3);
  assert.equal(changed.outlineCacheBypasses, 0);
  host.hooks.get('session/event')(host.session, { type: 'turn/start' });
  await host.inspect();
  const nextTurn = host.guard.getStats(host.session);
  assert.equal(nextTurn.outlineCacheLookups, 1);
  assert.equal(nextTurn.outlineCacheHits, 1);
  assert.equal(nextTurn.outlineCacheMisses, 0);
  assert.equal(nextTurn.outlineCacheHitRate, 1);
  assert.equal(host.reads(), 2);
});

test('disabled and unversioned caches bypass the hit-rate denominator', async () => {
  for (const mode of ['disabled', 'version', 'identity']) {
    const host = fixture(mode === 'disabled' ? { maxCacheEntries: 0 } : {});
    if (mode === 'version') host.service.stat = async () => ({ type: 'file', size: 64 });
    if (mode === 'identity') host.service.resolve = async () => ({ targetKey: '' });
    await host.inspect(); await host.inspect();
    const stats = host.guard.getStats(host.session);
    assert.equal(host.reads(), 2);
    assert.equal(stats.outlineCacheLookups, 0);
    assert.equal(stats.outlineCacheHits, 0);
    assert.equal(stats.outlineCacheMisses, 0);
    assert.equal(stats.outlineCacheBypasses, 2);
    assert.equal(stats.outlineCacheHitRate, null);
  }
});

test('failed content reads count as misses and mutation counts exclude absent cache groups', async () => {
  const host = fixture();
  await host.mutate('bash');
  assert.equal(host.guard.getStats(host.session).outlineCacheInvalidations, 0);
  host.service.readBytes = async () => { throw new Error('EACCES'); };
  assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
  const stats = host.guard.getStats(host.session);
  assert.equal(stats.outlineCacheLookups, 1);
  assert.equal(stats.outlineCacheMisses, 1);
  assert.equal(stats.outlineCacheBypasses, 0);
  await host.mutate('edit'); await host.mutate('edit_batch');
  assert.equal(host.guard.getStats(host.session).outlineCacheInvalidations, 1);
});

test('official disposal releases retained caches and stats while preserving other sessions', async t => {
  const cleared = [];
  const clear = OutlineCache.prototype.clear;
  t.mock.method(OutlineCache.prototype, 'clear', function () {
    clear.call(this);
    cleared.push(this);
  });
  const host = fixture();
  const other = {};
  await host.inspect(); await host.inspect(1, other);
  host.useBackend({ ...host.service });
  await host.inspect();
  host.useBackend(host.service);
  host.hooks.get('session/disposed')(host.session);
  host.hooks.get('session/disposed')(host.session);
  assert.equal(cleared.length, 2);
  for (const cache of cleared) {
    assert.equal(cache.entries.size, 0);
    assert.equal(cache.bytes, 0);
  }
  assert.equal(host.guard.getStats(host.session).inspected, 0);
  assert.equal(host.guard.getStats(host.session).outlineCacheHitRate, null);
  host.hooks.get('session/event')(host.session, { type: 'turn/start' });
  assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
  await host.inspect(1, other);
  assert.equal(host.reads(), 3);
  assert.equal(host.guard.getStats(other).outlineCacheHits, 1);
  host.hooks.get('dispose')();
  assert.equal(cleared.length, 3);
  assert.equal(new Set(cleared).size, 3);
  assert.equal(cleared[2].entries.size, 0);
  assert.doesNotMatch(await host.inspect(1, {}), /Remaining file outline/);
  assert.equal(host.reads(), 3);
});

test('session and plugin disposal reject inspections paused during preflight or content reads', async () => {
  for (const stage of ['stat', 'readBytes']) {
    for (const event of ['session/disposed', 'dispose']) {
      const host = fixture();
      const original = host.service[stage];
      let release;
      let entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      host.service[stage] = async (...args) => {
        entered();
        await gate;
        return original(...args);
      };
      const pending = host.inspect();
      await started;
      host.hooks.get(event)(host.session);
      release();
      assert.doesNotMatch(await pending, /Remaining file outline/);
      assert.equal(host.reads(), stage === 'stat' ? 0 : 1);
      const stats = host.guard.getStats(host.session);
      assert.equal(stats.inspected, 0);
      assert.equal(stats.outlineCacheLookups, 0);
      assert.equal(stats.outlineCacheHitRate, null);
      assert.doesNotMatch(await host.inspect(), /Remaining file outline/);
    }
  }
});

test('parsed-outline LRU enforces entry and byte bounds and refreshes recency', () => {
  const cache = new OutlineCache(2, 1024);
  const value = { entries: [{ line: 1, text: 'function a()', nested: false }], totalLines: 1 };
  cache.set('a', '1', value); cache.set('b', '1', value);
  assert.equal(cache.get('a', '1'), value);
  cache.set('c', '1', value);
  assert.equal(cache.get('b', '1'), null);
  assert.equal(cache.get('a', '2'), null);
  cache.set('huge', '1', { entries: [{ line: 1, text: 'x'.repeat(2000) }] });
  assert.equal(cache.get('huge', '1'), null);
  assert.ok(cache.bytes <= 1024);
  assert.ok(cache.entries.size <= 2);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.entries.size, 0);
});
