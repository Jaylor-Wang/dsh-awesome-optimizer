import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { extractCodeOutline, formatCodeOutline, formatOutlineEntries, supportsCodeOutline } from './code-outline.js';
import { buildAdaptiveOutline } from './ast-outline.js';
import { OutlineCache } from './outline-cache.js';

export { extractCodeOutline, formatCodeOutline };
export const READ_GUARD_SOURCE = 'optimizer-read-guard';

export const ReadGuardConfig = z.object({
  enabled: z.boolean().default(true),
  maxLineChars: z.number().step(1).min(100).max(50000).default(1500),
  injectTailOutline: z.boolean().default(true),
  maxOutlineEntries: z.number().step(1).min(3).max(60).default(20),
  maxOutlineBytes: z.number().step(1).min(256).max(8192).default(1536),
  maxInspectBytes: z.number().step(1).min(4096).max(4 * 1024 * 1024).default(512 * 1024),
  maxCacheEntries: z.number().step(1).min(0).max(256).default(32),
  maxCacheBytes: z.number().step(1).min(1024).max(8 * 1024 * 1024).default(256 * 1024),
  astOutline: z.union(['off', 'auto', 'always']).default('auto'),
  astGrepCommand: z.string().default('ast-grep'),
  astTimeoutMs: z.number().step(1).min(1).max(5000).default(750),
  astMaxOutputBytes: z.number().step(1).min(1024).max(1024 * 1024).default(256 * 1024)
});

function truncateLongLinesWithCount(text, maxLineChars = 1500) {
  if (typeof text !== 'string' || !maxLineChars || maxLineChars <= 0) {
    return { text, truncatedCount: 0 };
  }
  const lines = text.split('\n');
  let truncatedCount = 0;
  const out = lines.map(line => {
    if (line.length <= maxLineChars) return line;
    truncatedCount++;
    return `${line.slice(0, maxLineChars)}... [line truncated: +${line.length - maxLineChars} chars]`;
  });
  return truncatedCount > 0 ? { text: out.join('\n'), truncatedCount } : { text, truncatedCount: 0 };
}

export function truncateLongLines(text, maxLineChars = 1500) {
  return truncateLongLinesWithCount(text, maxLineChars).text;
}

function splitEnvelope(text) {
  const match = text.match(/^([\s\S]*?<content>\n)([\s\S]*)(\n<\/content>[\s\S]*)$/);
  if (!match) {
    return { prefix: '', body: text, suffix: '' };
  }
  return { prefix: match[1], body: match[2], suffix: match[3] };
}

function detectTruncation(body, meta) {
  if (meta && Array.isArray(meta.lines) && typeof meta.totalLines === 'number') {
    const endLine = meta.lines.at(-1)?.number ?? 0;
    if (endLine > 0 && endLine < meta.totalLines) {
      return { endLine, totalLines: meta.totalLines };
    }
  }
  const footerMatch = body.match(/\((?:Output capped\.\s*)?Showing lines \d+-(\d+)(?:\s+of\s+(\d+))?\.\s*Use offset=(\d+) to continue\.\)/);
  if (footerMatch) {
    const endLine = Number(footerMatch[1]);
    const totalLines = footerMatch[2] ? Number(footerMatch[2]) : undefined;
    if (Number.isInteger(endLine) && endLine > 0) {
      return { endLine, totalLines };
    }
  }
  return null;
}

async function readTargetSafely(filePath, cwd, fsService, signal, config, cache, stats) {
  const { maxInspectBytes } = config;
  if (signal?.aborted) return null;
  const generation = cache?.generation;

  if (fsService) {
    // A service failure is authoritative; never retry through another backend.
    try {
      if (typeof fsService.resolve !== 'function' || typeof fsService.stat !== 'function') return null;
      const target = await fsService.resolve(filePath, { cwd, signal });
      const info = await fsService.stat(target, signal);
      if (signal?.aborted || cache?.generation !== generation || info?.type !== 'file' || !Number.isFinite(info.size) || info.size < 0 || info.size > maxInspectBytes) return null;
      const key = typeof target?.targetKey === 'string' && target.targetKey ? JSON.stringify([target.targetKey, path.extname(filePath).toLowerCase()]) : null;
      const version = typeof info.version === 'string' && info.version ? info.version : null;
      if (cache?.maxEntries > 0 && key && version) {
        if (stats) stats.outlineCacheLookups++;
        const cached = cache.get(key, version);
        if (cached) {
          if (stats) stats.outlineCacheHits++;
          return cached;
        }
        if (stats) stats.outlineCacheMisses++;
      } else if (stats) {
        stats.outlineCacheBypasses++;
      }
      let content;
      if (typeof fsService.readBytes === 'function') {
        const bytes = await fsService.readBytes(target, signal, maxInspectBytes);
        if (signal?.aborted || bytes.byteLength > maxInspectBytes) return null;
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else if (typeof fsService.streamText === 'function') {
        const chunks = [];
        let size = 0;
        for await (const chunk of await fsService.streamText(target, signal)) {
          if (signal?.aborted || typeof chunk !== 'string') return null;
          size += Buffer.byteLength(chunk, 'utf8');
          if (size > maxInspectBytes) return null;
          chunks.push(chunk);
        }
        content = chunks.join('');
      } else if (typeof fsService.readText === 'function') {
        // Compatibility with older services: only after a successful size preflight.
        content = await fsService.readText(target, signal);
      } else {
        return null;
      }
      if (signal?.aborted || cache?.generation !== generation || typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > maxInspectBytes) return null;
      const outline = await buildAdaptiveOutline(content, filePath, config, signal, stats);
      if (signal?.aborted || cache?.generation !== generation) return null;
      if (key && version) {
        const after = await fsService.stat(target, signal);
        if (signal?.aborted || cache?.generation !== generation || after?.type !== 'file' || after.version !== version || after.size !== info.size) return null;
        cache?.set(key, version, outline);
      }
      return outline;
    } catch {
      return null;
    }
  }

  // Standalone hosts without an fs service still get a bounded local read.
  let handle;
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    handle = await fs.open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxInspectBytes || signal?.aborted || cache?.generation !== generation) return null;
    if (stats) stats.outlineCacheBypasses++;
    const buffer = Buffer.alloc(maxInspectBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      if (signal?.aborted) return null;
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (signal?.aborted || cache?.generation !== generation || size > maxInspectBytes) return null;
    const outline = await buildAdaptiveOutline(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)), filePath, config, signal, stats);
    return signal?.aborted || cache?.generation !== generation ? null : outline;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Protect direct `read` calls against giant minified lines and blind large-file truncation
 * by enforcing single-line caps and appending a compact structural outline of unread tail lines.
 */
function emptyStats() {
  return {
    inspected: 0, linesTruncated: 0, outlinesInjected: 0,
    outlineCacheLookups: 0, outlineCacheHits: 0, outlineCacheMisses: 0,
    outlineCacheBypasses: 0, outlineCacheInvalidations: 0,
    astAttempts: 0, astSucceeded: 0, astFallbacks: 0, astTimeouts: 0
  };
}

export function applyReadGuard(ctx, rawConfig = {}) {
  const config = ReadGuardConfig(rawConfig);
  if (!config.enabled) return null;

  const statsBySession = new WeakMap();
  const cachesBySession = new WeakMap();
  const disposedSessions = new WeakSet();
  let disposed = false;
  const anonymousSession = {};
  const localBackend = {};
  const liveCacheRefs = new Set();
  const cacheRefByInstance = new WeakMap();
  const cacheFinalizer = new FinalizationRegistry(ref => {
    liveCacheRefs.delete(ref);
  });
  const clearCaches = session => {
    const caches = cachesBySession.get(session ?? anonymousSession);
    for (const cache of caches?.values() ?? []) {
      cache.clear();
      cacheFinalizer.unregister(cache);
      const ref = cacheRefByInstance.get(cache);
      if (ref) liveCacheRefs.delete(ref);
    }
    cachesBySession.delete(session ?? anonymousSession);
    return Boolean(caches?.size);
  };
  const cacheFor = (session, backend) => {
    const key = session ?? anonymousSession;
    let caches = cachesBySession.get(key);
    if (!caches) {
      caches = new Map();
      cachesBySession.set(key, caches);
    }
    let cache = caches.get(backend ?? localBackend);
    if (!cache) {
      cache = new OutlineCache(config.maxCacheEntries, config.maxCacheBytes);
      caches.set(backend ?? localBackend, cache);
      const ref = new WeakRef(cache);
      cacheRefByInstance.set(cache, ref);
      liveCacheRefs.add(ref);
      cacheFinalizer.register(cache, ref, cache);
    }
    return cache;
  };
  ctx.on('dispose', () => {
    disposed = true;
    for (const ref of liveCacheRefs) {
      const cache = ref.deref();
      if (cache) {
        cache.clear();
        cacheFinalizer.unregister(cache);
      }
    }
    liveCacheRefs.clear();
  });
  const statsFor = session => {
    if (disposed || !session || disposedSessions.has(session)) return null;
    let s = statsBySession.get(session);
    if (!s) {
      s = emptyStats();
      statsBySession.set(session, s);
    }
    return s;
  };

  ctx.on('session/disposed', session => {
    if (!session) return;
    disposedSessions.add(session);
    clearCaches(session);
    statsBySession.delete(session);
  });
  ctx.on('session/event', (session, event) => {
    if (!disposed && session && !disposedSessions.has(session) && event?.type === 'turn/start') {
      statsBySession.set(session, emptyStats());
    }
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    const session = exec.agent?.session;
    if (disposed || (session && disposedSessions.has(session))) return decision;
    // Invalidate conservatively even for failed/partially successful composite mutations.
    if (['write', 'edit', 'edit_batch', 'bash', 'eval_node', 'eval_python'].includes(exec?.name)) {
      if (clearCaches(session)) {
        const stats = statsFor(session);
        if (stats) stats.outlineCacheInvalidations++;
      }
    }
    if (
      decision?.kind === 'block' ||
      exec?.name !== 'read' ||
      exec.parent !== undefined ||
      result?.isError ||
      exec.signal?.aborted
    ) {
      return decision;
    }

    const baseBlocks = decision?.content ?? result.content;
    if (!Array.isArray(baseBlocks) || baseBlocks.length === 0) return decision;

    const stats = statsFor(session);
    if (stats) stats.inspected++;

    let changed = false;
    const updatedBlocks = baseBlocks.map(block => ({ ...block }));

    // 1. Single-line cap on text blocks (preserves DSH <content>...</content> wrapper if present)
    for (let i = 0; i < updatedBlocks.length; i++) {
      const block = updatedBlocks[i];
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const { prefix, body, suffix } = splitEnvelope(block.text);
      const { text: truncatedBody, truncatedCount } = truncateLongLinesWithCount(body, config.maxLineChars);
      if (truncatedCount > 0) {
        block.text = `${prefix}${truncatedBody}${suffix}`;
        changed = true;
        if (stats) stats.linesTruncated += truncatedCount;
      }
    }

    // 2. Blind-read tail outline injection (only when caller omitted both offset & limit and hit truncation)
    const args = exec.arguments ?? {};
    const isBlindRead = args.offset === undefined && args.limit === undefined && typeof args.file_path === 'string' && args.file_path.trim().length > 0;
    if (config.injectTailOutline && isBlindRead && supportsCodeOutline(args.file_path)) {
      const firstTextIdx = updatedBlocks.findIndex(b => b.type === 'text' && typeof b.text === 'string');
      if (firstTextIdx !== -1) {
        const { prefix, body, suffix } = splitEnvelope(updatedBlocks[firstTextIdx].text);
        const trunc = detectTruncation(body, result.meta);
        if (trunc) {
          let cwd = '';
          try {
            cwd = ctx.get('workingDirectory')?.get?.(session) ?? '';
          } catch {
            cwd = '';
          }
          let fsService;
          let fsUnavailable = false;
          try {
            fsService = ctx.get('fs');
          } catch {
            // An unavailable/denied service is not permission to bypass it.
            fsUnavailable = true;
          }

          const parsed = fsUnavailable
            ? null
            : await readTargetSafely(args.file_path, cwd, fsService, exec.signal, config, cacheFor(session, fsService), stats);
          if (parsed !== null && !exec.signal?.aborted && !disposed && !(session && disposedSessions.has(session))) {
            const { totalLines } = parsed;
            if (totalLines > trunc.endLine) {
              const outline = formatOutlineEntries(parsed.entries, {
                startLine: trunc.endLine + 1,
                endLine: totalLines,
                maxEntries: config.maxOutlineEntries,
                maxBytes: config.maxOutlineBytes
              });
              if (outline) {
                const note = `[${READ_GUARD_SOURCE}] Remaining file outline (lines ${trunc.endLine + 1}-${totalLines}):\n${outline}\nUse read(file_path, offset=..., limit=...) to jump directly.`;
                updatedBlocks[firstTextIdx].text = `${prefix}${body}\n\n${note}${suffix}`;
                changed = true;
                if (stats) stats.outlinesInjected++;
              }
            }
          }
        }
      }
    }

    if (!changed) return decision;
    return {
      kind: 'accept',
      content: updatedBlocks,
      ...(decision?.additionalContexts ? { additionalContexts: decision.additionalContexts } : {})
    };
  });

  return {
    getStats(session) {
      const stats = (!disposed && session && !disposedSessions.has(session) ? statsBySession.get(session) : null) ?? emptyStats();
      return {
        ...stats,
        outlineCacheHitRate: stats.outlineCacheLookups ? stats.outlineCacheHits / stats.outlineCacheLookups : null
      };
    }
  };
}

export const name = 'agent-optimizer-read-guard';
export const inject = ['tools'];
export const Config = ReadGuardConfig;
export function apply(ctx, config = {}) {
  const service = applyReadGuard(ctx, config);
  if (service) ctx.provide('readGuard', service);
}
export default { name, inject, Config, apply };
