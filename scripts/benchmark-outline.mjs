import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { applyReadGuard } from '../src/read-guard.js';

const samples = 20;
const source = [
  'import React from "react";',
  ...Array.from({ length: 40 }, (_, i) => `export const Panel${i} = () => <section data-id="${i}">Panel ${i}</section>;`),
  'export class Controller {',
  '  async render(value: string) { return value; }',
  '}'
].join('\n');

const ordinarySource = [
  'export interface Value { id: string; }',
  ...Array.from({ length: 40 }, (_, i) => `export function value${i}(item: Value): string { return item.id; }`)
].join('\n');

function host(astOutline, maxCacheEntries, content) {
  const hooks = new Map();
  const session = {};
  let reads = 0;
  let stats = 0;
  const filesystem = {
    resolve: async () => ({ targetKey: 'benchmark:panel.tsx' }),
    stat: async () => { stats++; return { type: 'file', size: Buffer.byteLength(content), version: 'fixture-v1' }; },
    readBytes: async () => { reads++; return Buffer.from(content); }
  };
  const guard = applyReadGuard({
    on(name, callback) { hooks.set(name, callback); },
    get(name) { return name === 'fs' ? filesystem : undefined; }
  }, { astOutline, maxCacheEntries, astTimeoutMs: 2000 });
  return {
    async inspect(filePath = 'panel.tsx') {
      const result = { content: [{ type: 'text', text: `<content>\n1: import\n\n(Showing lines 1-1 of ${content.split('\n').length}. Use offset=2 to continue.)\n</content>` }] };
      const started = performance.now();
      const decision = await hooks.get('tools/post-execute')({ name: 'read', arguments: { file_path: filePath }, agent: { session } }, result, async () => undefined);
      const durationMs = performance.now() - started;
      const text = decision?.content?.[0]?.text ?? '';
      assert.match(text, /Remaining file outline/);
      assert.match(text, /Panel0|value0/);
      return durationMs;
    },
    counts: () => ({ contentReads: reads, statCalls: stats, ...guard.getStats(session) }),
    dispose() { hooks.get('dispose')(); }
  };
}

function summarize(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const rounded = number => Number(number.toFixed(3));
  return {
    samples: sorted.length, minMs: rounded(sorted[0]),
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: rounded(sorted.at(-1))
  };
}

async function measure(astOutline, cacheEntries, filePath, content = source) {
  const fixture = host(astOutline, cacheEntries, content);
  try {
    const firstMs = await fixture.inspect(filePath);
    const firstCounts = fixture.counts();
    const durations = [];
    for (let i = 0; i < samples; i++) durations.push(await fixture.inspect(filePath));
    return { firstMs: Number(firstMs.toFixed(3)), firstCounts, repeated: summarize(durations), finalCounts: fixture.counts() };
  } finally { fixture.dispose(); }
}

// First measurement is the first ast-grep launch in this benchmark process.
const astUncached = await measure('always', 0, 'panel.tsx');
const lexical = await measure('off', 0, 'panel.tsx');
const autoOrdinary = await measure('auto', 0, 'ordinary.ts', ordinarySource);
const astCached = await measure('auto', 32, 'panel.tsx');
const largeSource = `${'// source padding to measure a larger authorized snapshot\n'.repeat(2400)}${source}`;
const astLarge = await measure('auto', 32, 'large-panel.tsx', largeSource);
assert.equal(astUncached.finalCounts.astSucceeded, samples + 1);
assert.equal(astUncached.finalCounts.contentReads, samples + 1);
assert.equal(lexical.finalCounts.astAttempts, 0);
assert.equal(autoOrdinary.finalCounts.astAttempts, 0);
assert.equal(astCached.finalCounts.astSucceeded, 1);
assert.equal(astCached.finalCounts.contentReads, 1);
assert.equal(astCached.finalCounts.outlineCacheHits, samples);
assert.equal(astLarge.finalCounts.astSucceeded, 1);
assert.equal(astLarge.finalCounts.outlineCacheHits, samples);
const report = {
  measuredAt: new Date().toISOString(),
  platform: process.platform, architecture: process.arch,
  osRelease: os.release(), node: process.version,
  sourceBytes: Buffer.byteLength(source), sourceLines: source.split('\n').length,
  ordinarySourceBytes: Buffer.byteLength(ordinarySource), ordinarySourceLines: ordinarySource.split('\n').length,
  methodology: 'Real ast-grep CLI over stdin; in-memory versioned fs isolates parsing/spawn cost. First invocation is process-cold, not a flushed OS disk cache. Repeated uncached samples launch a fresh CLI each time. Cache hits include resolve/stat and rendering but no content read or process. No network or model calls.',
  astUncached, lexical, autoOrdinary, astCached,
  astLarge: { sourceBytes: Buffer.byteLength(largeSource), sourceLines: largeSource.split('\n').length, ...astLarge }
};
const outputPath = process.argv[2];
if (outputPath) await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
