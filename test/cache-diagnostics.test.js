import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTelemetry } from '../src/telemetry.js';
import { CacheDiagnostics } from '../src/cache-diagnostics.js';

test('telemetry installs the opt-in observer and persists redacted JSON diagnostics', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'optimizer-cache-test-'));
  const file = path.join(directory, 'capture.jsonl');
  const saved = globalThis.fetch;
  const hooks = new Map();
  const ctx = { on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); } };
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: { prompt_tokens: 10, cached_tokens: 0 }, content: 'PRIVATE' }), { headers: { 'content-type': 'application/json' } });
  const fake = globalThis.fetch;
  try {
    applyTelemetry(ctx, { trackStreams: false, cacheDiagnosticsPath: file });
    const middleware = hooks.get('llm/stream')[0];
    for await (const chunk of middleware({ sessionId: 'local-test' }, async function* () {
      const response = await fetch(endpoint, { body: JSON.stringify({ model: 'model', messages }) });
      yield await response.json();
    })) assert.equal(chunk.usage.cached_tokens, 0);
    for (const dispose of hooks.get('dispose') ?? []) await dispose();
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r => r.type), ['request', 'response', 'usage', 'complete']);
    assert.equal(records[2].usage.cached_tokens, 0);
    assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
  } finally {
    for (const dispose of hooks.get('dispose') ?? []) dispose();
    assert.equal(globalThis.fetch, fake);
    globalThis.fetch = saved;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('optimizer-cache-test-'));
    rmSync(directory, { recursive: true });
  }
});

const endpoint = 'https://example.invalid/v1/chat/completions';
const messages = [{ role: 'user', content: 'SECRET PROMPT' }];

test('HTTP zero remains visible when the adapter omits the same counter in the turn summary', async () => {
  const hooks = new Map();
  const ctx = { on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); } };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'optimizer-cache-test-'));
  const file = path.join(directory, 'capture.jsonl');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: {
    prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }
  } }), { headers: { 'content-type': 'application/json' } });
  const session = { id: 'http-vs-adapter' };
  try {
    const manager = applyTelemetry(ctx, { cacheDiagnosticsPath: file });
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
    const options = { sessionId: session.id, messages };
    const stream = hooks.get('llm/stream').reduceRight((next, hook) => () => hook(options, next), async function* () {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ model: 'test', messages }) });
      const { usage } = await response.json();
      yield { type: 'usage', usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } };
    });
    for await (const _ of stream()) {}
    for (const dispose of hooks.get('dispose') ?? []) await dispose();
    const rawUsage = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.type === 'usage');
    assert.equal(rawUsage.usage.prompt_tokens_details.cached_tokens, 0);
    const summary = manager.getSummary(session);
    assert.equal(summary.usage.inputTokens, 10);
    assert.equal(summary.usage.cacheReadTokens, null);
    assert.deepEqual(summary.cacheUsageCoverage, { streamAttempts: 1, readReported: 0, writeReported: 0 });
  } finally {
    for (const dispose of hooks.get('dispose') ?? []) await dispose();
    globalThis.fetch = savedFetch;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('optimizer-cache-test-'));
    rmSync(directory, { recursive: true });
  }
});

test('HTTP diagnostics enforce byte limits per SSE event regardless of chunk boundaries', async () => {
  const saved = globalThis.fetch;
  const encoder = new TextEncoder();
  const max = 1024 * 1024;
  const usage = 'data: {"usage":{"prompt_tokens":17}}\r\n\r\n';
  const event = text => `data: ${JSON.stringify({ text })}\r\n\r\n`;
  const first = event('界'.repeat(200000));
  const oversized = event('界'.repeat(350000));
  const coalesced = encoder.encode(first + first + usage);
  const splitAt = encoder.encode(first).length;
  assert.ok(splitAt < max && coalesced.length > max);
  const over = encoder.encode(oversized + usage);
  assert.ok(oversized.length < max && encoder.encode(oversized).length > max);
  const crOnly = encoder.encode(usage.replaceAll('\r\n', '\r'));
  const endpointBody = JSON.stringify({ messages });
  const scenarios = [
    { bytes: coalesced, cuts: [], expected: 17 },
    // Split inside UTF-8 and between CR and LF in the SSE separator.
    { bytes: coalesced, cuts: [20, splitAt - 1, coalesced.length - 1], expected: 17 },
    { bytes: over, cuts: [max - 4, max + 1], expected: null },
    { bytes: crOnly, cuts: [crOnly.length - 1], expected: 17 },
    // Trailing SSE event without a final blank line before EOF must still be observed on flush().
    { bytes: encoder.encode('data: {"usage":{"prompt_tokens":23}}'), cuts: [], expected: 23 },
    { bytes: encoder.encode('data: {"usage":{"prompt_tokens":29}}\n'), cuts: [], expected: 29 }
  ];
  const records = [];
  let chunks;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  const diagnostics = new CacheDiagnostics(null, { sink: record => records.push(record) });
  try {
    for (const { bytes, cuts, expected } of scenarios) {
      const boundaries = [0, ...cuts, bytes.length];
      chunks = boundaries.slice(1).map((end, index) => bytes.subarray(boundaries[index], end));
      records.length = 0;
      const stream = diagnostics.wrap('byte-limit', async function* () {
        const response = await fetch(endpoint, { body: endpointBody });
        yield new Uint8Array(await response.arrayBuffer());
      });
      for await (const body of stream) assert.deepEqual(body, bytes);
      assert.equal(records.find(record => record.type === 'usage')?.usage.prompt_tokens ?? null, expected);
      assert.equal(records.filter(record => record.type === 'capture-gap').length, Number(expected === null));
      assert.equal(records.at(-1).captureGap, expected === null);
    }
  } finally {
    await diagnostics.dispose();
    globalThis.fetch = saved;
  }
});

test('HTTP diagnostics preserve bytes, isolate sessions, compare prefixes and retain raw zero/missing usage', async () => {
  const saved = globalThis.fetch;
  const records = [];
  let usage = { prompt_tokens: 100 };
  let cancelled = false;
  let fail = false;
  let lastBytes;
  globalThis.fetch = async () => {
    if (fail) throw new Error('transport failure');
    const text = `data: ${JSON.stringify({ id: 'req-1', model: 'model', usage, choices: [{ delta: { content: 'SECRET RESPONSE' } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    lastBytes = text;
    const bytes = new TextEncoder().encode(text);
    const response = new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'http-1', authorization: 'SECRET TOKEN' } });
    Object.defineProperties(response, { url: { value: endpoint }, redirected: { value: true }, type: { value: 'cors' } });
    return response;
  };
  const fake = globalThis.fetch;
  const diagnostics = new CacheDiagnostics(null, { sink: record => records.push(record) });
  const run = async (session, items = messages, cancel = false) => {
    const stream = diagnostics.wrap(session, async function* () {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ model: 'model', messages: items, tools: [], stream: true }) });
      assert.equal(response.url, endpoint);
      assert.equal(response.redirected, true);
      assert.equal(response.type, 'cors');
      if (session === 'a' && items === messages) {
        const clone = response.clone();
        assert.equal(clone.url, endpoint);
        assert.equal(clone.type, 'cors');
        assert.equal(await clone.text(), lastBytes);
      }
      if (cancel) await response.body.cancel();
      else assert.equal(await response.text(), lastBytes);
      yield 'done';
    });
    for await (const value of stream) assert.equal(value, 'done');
  };
  try {
    await run('a');
    usage = { prompt_tokens: 101, prompt_tokens_details: { cached_tokens: 0 } };
    await run('a', [...messages, { role: 'assistant', content: 'new' }]);
    await run('a', [{ role: 'user', content: 'changed' }]);
    await Promise.all([run('b'), run('c')]);
    const requests = records.filter(r => r.type === 'request');
    assert.deepEqual(requests.map(r => r.prefixStable), [null, true, false, null, null]);
    assert.equal(requests[2].firstDifference, 0);
    assert.notEqual(requests[3].session, requests[4].session);
    assert.notEqual(requests[3].request, requests[4].request);
    const usages = records.filter(r => r.type === 'usage');
    assert.equal('prompt_tokens_details' in usages[0].usage, false);
    assert.equal(usages[1].usage.prompt_tokens_details.cached_tokens, 0);
    assert.equal(JSON.stringify(records).includes('SECRET'), false);
    const count = records.length;
    await (await fetch(endpoint)).text();
    assert.equal(records.length, count);
    await run('cancel', messages, true);
    assert.ok(cancelled);
    fail = true;
    await assert.rejects(run('failed'), /transport failure/);
    assert.ok(records.some(r => r.type === 'transport-error'));
    fail = false;
    const throwing = new CacheDiagnostics(null, { sink() { throw new Error('observer failed'); } });
    try {
      for await (const value of throwing.wrap('d', async function* () { yield await (await fetch(endpoint, { body: JSON.stringify({ messages }) })).text(); })) assert.ok(value);
    } finally { throwing.dispose(); }
  } finally {
    diagnostics.dispose();
    assert.equal(globalThis.fetch, fake);
    globalThis.fetch = saved;
  }
});
