import fs from 'node:fs/promises';
import path from 'node:path';

export const UNAVAILABLE_FS = Object.freeze({});

/**
 * Resolve host `fs` service safely.
 * Returns `undefined` when absent (standalone host), or `UNAVAILABLE_FS` when lookup throws
 * so callers never bypass a denied/broken filesystem service via local disk.
 */
export function getFsService(ctx) {
  try {
    return ctx?.get ? ctx.get('fs') : undefined;
  } catch {
    return UNAVAILABLE_FS;
  }
}

/**
 * Resolve session working directory safely without letting missing services throw.
 */
export function getWorkingDirectory(ctx, session) {
  try {
    const cwdService = ctx?.get ? ctx.get('workingDirectory') : undefined;
    const cwd = cwdService?.get?.(session);
    return typeof cwd === 'string' ? cwd : '';
  } catch {
    return '';
  }
}

function isMissingError(err) {
  return err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND';
}

/**
 * Bounded chunked UTF-8 local disk read for standalone hosts without an `fs` service.
 * Allocates chunks proportional to `stat.size` (capped at 64 KiB) instead of upfront `maxBytes`.
 */
export async function readBoundedLocalFile(resolvedPath, signal, maxBytes, { onBeforeRead } = {}) {
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  let handle;
  try {
    handle = await fs.open(resolvedPath, 'r');
    const stat = await handle.stat();
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    if (!stat.isFile()) return { ok: false, reason: 'invalid' };
    if (stat.size > maxBytes) return { ok: false, reason: 'oversized' };
    if (typeof onBeforeRead === 'function' && onBeforeRead(stat) === false) {
      return { ok: false, reason: 'aborted' };
    }
    const chunks = [];
    let size = 0;
    const chunkSize = Math.min(65536, Math.max(stat.size + 1, 4096));
    while (size <= maxBytes) {
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      const toRead = Math.min(chunkSize, maxBytes + 1 - size);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) return { ok: false, reason: 'oversized' };
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return { ok: true, content };
  } catch (err) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read UTF-8 content through the host `fs` service using the narrowest bounded seam available.
 * A failure on a seam is authoritative and never falls through to wider seams or local disk.
 */
export async function readFsContent(fsService, {
  filePath,
  cwd = '',
  target,
  signal,
  maxBytes,
  allowReadFile = true
}) {
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  if (!fsService) return { ok: false, reason: 'unsupported' };

  if (typeof fsService.readBytes === 'function') {
    try {
      const bytes = await fsService.readBytes(target ?? filePath, signal, maxBytes);
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      if (!bytes) return { ok: false, reason: 'invalid' };
      if (bytes.byteLength > maxBytes) return { ok: false, reason: 'oversized' };
      return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch (err) {
      return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
    }
  }

  if (typeof fsService.streamText === 'function') {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of await fsService.streamText(target ?? filePath, signal)) {
        if (signal?.aborted) return { ok: false, reason: 'aborted' };
        if (typeof chunk !== 'string') return { ok: false, reason: 'invalid' };
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > maxBytes) return { ok: false, reason: 'oversized' };
        chunks.push(chunk);
      }
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      return { ok: true, content: chunks.join('') };
    } catch (err) {
      return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
    }
  }

  if (allowReadFile && typeof fsService.readFile === 'function') {
    try {
      const content = await fsService.readFile(filePath, { cwd, signal, encoding: 'utf8' });
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      if (typeof content !== 'string') return { ok: false, reason: 'invalid' };
      if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, reason: 'oversized' };
      return { ok: true, content };
    } catch (err) {
      return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
    }
  }

  if (typeof fsService.readText === 'function') {
    try {
      const content = await fsService.readText(target ?? filePath, signal);
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      if (typeof content !== 'string') return { ok: false, reason: 'invalid' };
      if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, reason: 'oversized' };
      return { ok: true, content };
    } catch (err) {
      return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
    }
  }

  return { ok: false, reason: 'unsupported' };
}

/**
 * Unified preflight reader (`resolve` -> `stat` size gate -> bounded content read)
 * shared by `edit_batch` preflight and `editRecovery`.
 */
export async function readFilePreflight({
  filePath,
  cwd = '',
  fsService,
  target: resolvedTarget,
  signal,
  maxBytes,
  allowReadFile = true
}) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, reason: 'invalid' };
  if (signal?.aborted) return { ok: false, reason: 'aborted' };

  if (fsService) {
    // A service failure is authoritative; never bypass sandbox or cancellation through local disk.
    let target = resolvedTarget;
    if (target === undefined && typeof fsService.resolve === 'function') {
      try {
        target = await fsService.resolve(filePath, { cwd, signal });
      } catch (err) {
        return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
      }
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted' };

    if (target !== undefined && typeof fsService.stat === 'function') {
      try {
        const info = await fsService.stat(target, signal);
        if (signal?.aborted) return { ok: false, reason: 'aborted' };
        if (info !== undefined) {
          if (info.type !== undefined && info.type !== 'file') {
            return { ok: false, reason: 'invalid' };
          }
          if (Number.isFinite(info.size) && (info.size < 0 || info.size > maxBytes)) {
            return { ok: false, reason: 'oversized' };
          }
        }
      } catch (err) {
        return { ok: false, reason: isMissingError(err) ? 'missing' : 'error', error: err };
      }
    }

    return readFsContent(fsService, {
      filePath,
      cwd,
      target,
      signal,
      maxBytes,
      allowReadFile
    });
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
  return readBoundedLocalFile(resolved, signal, maxBytes);
}
