import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

const scope = new AsyncLocalStorage();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let users = 0;
let originalFetch;
let wrappedFetch;
const MAX_EVENT = 1024 * 1024;

function numericUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return {};
  const out = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens',
    'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'input_tokens', 'output_tokens',
    'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_tokens_details',
    'input_tokens_details', 'reasoning_tokens']) {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else if (item && typeof item === 'object') out[key] = numericUsage(item, depth + 1);
  }
  return out;
}

function identifier(value) {
  return typeof value === 'string' && value.length <= 256 && /^[\w.:/-]+$/.test(value) ? value : null;
}

function preserveMetadata(target, source) {
  for (const key of ['url', 'redirected', 'type']) {
    Object.defineProperty(target, key, { value: source[key], configurable: true });
  }
  const clone = target.clone.bind(target);
  Object.defineProperty(target, 'clone', { value: () => preserveMetadata(clone(), source), configurable: true });
  return target;
}

// One transport wrapper; only fetches inside an explicitly enabled LLM scope are observed.
function acquire() {
  if (users++ !== 0) return;
  originalFetch = globalThis.fetch;
  const delegate = originalFetch;
  wrappedFetch = async function (input, init) {
    const active = scope.getStore();
    if (!active || active.owner.closed || active.owner.stopped) return delegate(input, init);
    let record;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.pathname.endsWith('/chat/completions') || typeof init?.body !== 'string') {
        return delegate(input, init);
      }
      const body = JSON.parse(init.body);
      if (!Array.isArray(body.messages)) return delegate(input, init);
      record = active.owner.request(active.session, body, url);
    } catch { /* Observation must not fail inference. */ }
    let response;
    try { response = await delegate(input, init); }
    catch (error) {
      if (record) active.owner.emit({ type: 'transport-error', request: record.request });
      throw error;
    }
    if (!record) return response;
    active.owner.emit({ type: 'response', request: record.request, status: response.status,
      requestId: identifier(response.headers.get('x-request-id') ?? response.headers.get('request-id')) });
    if (!response.body) return response;
    const contentType = response.headers.get('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');
    if (!isSse && !contentType.includes('application/json')) return response;
    const decoder = new TextDecoder();
    let pending = '';
    let pendingBytes = 0;
    let dropped = false;
    let lineHasContent = false;
    let afterCr = false;
    let afterBlankCr = false;
    const observe = text => {
      try {
        const event = JSON.parse(text);
        if (event.usage) active.owner.emit({ type: 'usage', request: record.request,
          usage: numericUsage(event.usage), responseId: identifier(event.id),
          model: identifier(event.model), systemFingerprint: identifier(event.system_fingerprint) });
      } catch { /* Ignore non-JSON events such as [DONE]. */ }
    };
    const emitSseEvent = rawEvent => {
      const data = rawEvent.split(/\r\n|\r|\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (data) observe(data);
    };
    const append = bytes => {
      pendingBytes += bytes.byteLength;
      if (pendingBytes <= MAX_EVENT) {
        pending += decoder.decode(bytes, { stream: true });
        return true;
      }
      dropped = true;
      pending = '';
      active.owner.emit({ type: 'capture-gap', request: record.request, reason: 'event-size-limit' });
      return false;
    };
    const inspect = bytes => {
      if (dropped) return;
      if (!isSse) {
        append(bytes);
        return;
      }

      // Frame events on the wire before decoding or comparing their byte lengths.
      // CRLF is one line ending even when it crosses a chunk boundary.
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        const continuesCr = afterCr && byte === 10;
        const skip = continuesCr && afterBlankCr;
        afterCr = byte === 13;
        afterBlankCr = false;
        if (skip) start = i + 1;
        if (continuesCr) continue;
        if (byte !== 10 && byte !== 13) {
          lineHasContent = true;
          continue;
        }
        if (lineHasContent) {
          lineHasContent = false;
          continue;
        }

        if (!append(bytes.subarray(start, i))) return;
        emitSseEvent(pending + decoder.decode());
        pending = '';
        pendingBytes = 0;
        afterBlankCr = afterCr;
        start = i + 1;
      }
      if (start < bytes.length) append(bytes.subarray(start));
    };
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        try { inspect(chunk); } catch { /* Preserve the original stream. */ }
        controller.enqueue(chunk);
      },
      flush() {
        try {
          if (!dropped) {
            const tail = pending + decoder.decode();
            if (tail) {
              if (isSse) emitSseEvent(tail);
              else observe(tail);
            }
          }
        } catch { /* Preserve stream completion. */ }
        active.owner.emit({ type: 'complete', request: record.request, captureGap: dropped });
      }
    }));
    return preserveMetadata(new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }), response);
  };
  globalThis.fetch = wrappedFetch;
}

export class CacheDiagnostics {
  constructor(filePath, { sink, maxBytes = 8 * 1024 * 1024, onStop, maxQueuedBytes = 256 * 1024, writer = appendFile } = {}) {
    this.previous = new Map();
    this.onStop = onStop;
    this.stopped = false;
    this.maxQueuedBytes = maxQueuedBytes;
    this.queuedBytes = 0;
    this.pending = Promise.resolve();
    this.writer = writer;
    this.closed = false;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.sink = sink;
    this.filePath = filePath;
    if (!sink) {
      if (!path.isAbsolute(filePath)) throw new Error('Cache diagnostic path must be absolute');
      mkdirSync(path.dirname(filePath), { recursive: true });
      try { this.bytes = statSync(filePath).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    acquire();
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.previous.clear();
    try { this.onStop?.(reason); } catch {}
  }

  flush() { return this.pending; }

  emit(record) {
    if (this.closed || this.stopped) return;
    try {
      const line = JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n';
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes) { this.stop('file-size-limit'); return; }
      if (!this.sink && this.queuedBytes + bytes > this.maxQueuedBytes) { this.stop('queue-size-limit'); return; }
      this.bytes += bytes;
      if (this.sink) this.sink(JSON.parse(line));
      else {
        this.queuedBytes += bytes;
        this.pending = this.pending.then(async () => {
          try {
            if (!this.writeFailed) await this.writer(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
          } catch { this.writeFailed = true; this.stop('write-failed'); }
          finally { this.queuedBytes -= bytes; }
        });
      }
    } catch { this.stop('observer-failed'); }
  }

  request(session, body, url) {
    const messages = body.messages.map(digest);
    const { messages: ignored, ...config } = body;
    const configDigest = digest(config);
    const key = digest([session, url.origin, url.pathname, body.model]);
    const previous = this.previous.get(key);
    let firstDifference = null;
    if (previous) {
      for (let i = 0; i < previous.messages.length; i++) {
        if (messages[i] !== previous.messages[i]) { firstDifference = i; break; }
      }
    }
    const record = { type: 'request', request: randomUUID(), session: digest(session),
      endpoint: digest(url.origin + url.pathname), model: identifier(body.model),
      messages, configDigest, toolsDigest: body.tools === undefined ? null : digest(body.tools),
      cacheKeyDigest: body.prompt_cache_key === undefined ? null : digest(body.prompt_cache_key),
      previousRequest: previous?.request ?? null, firstDifference,
      prefixStable: previous ? firstDifference === null : null,
      configStable: previous ? configDigest === previous.configDigest : null };
    this.previous.delete(key);
    this.previous.set(key, record);
    if (this.previous.size > 128) this.previous.delete(this.previous.keys().next().value);
    this.emit(record);
    return record;
  }

  wrap(session, next) {
    if (session === undefined || session === null || this.closed) return next();
    const active = { owner: this, session: String(session) };
    return (async function* () {
      const stream = scope.run(active, next);
      const iterator = stream[Symbol.asyncIterator]();
      try {
        while (true) {
          const result = await scope.run(active, () => iterator.next());
          if (result.done) return;
          yield result.value;
        }
      } finally { if (iterator.return) await scope.run(active, () => iterator.return()); }
    })();
  }

  dispose() {
    if (this.closed) return this.flush();
    this.closed = true;
    this.previous.clear();
    if (--users === 0 && globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    return this.flush();
  }
}
