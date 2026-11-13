import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { formatCodeOutline } from './code-outline.js';

export const READ_GUARD_SOURCE = 'optimizer-read-guard';

export const ReadGuardConfig = z.object({
  enabled: z.boolean().default(true),
  maxLineChars: z.number().step(1).min(100).max(50000).default(1500),
  injectTailOutline: z.boolean().default(true),
  maxOutlineEntries: z.number().step(1).min(3).max(60).default(20),
  maxOutlineBytes: z.number().step(1).min(256).max(8192).default(1536),
  maxInspectBytes: z.number().step(1).min(4096).max(4 * 1024 * 1024).default(512 * 1024)
});

export function truncateLongLines(text, maxLineChars = 1500) {
  if (typeof text !== 'string' || !maxLineChars || maxLineChars <= 0) return text;
  const lines = text.split('\n');
  let modified = false;
  const out = lines.map(line => {
    if (line.length <= maxLineChars) return line;
    modified = true;
    return `${line.slice(0, maxLineChars)}... [line truncated: +${line.length - maxLineChars} chars]`;
  });
  return modified ? out.join('\n') : text;
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

async function readTargetSafely(filePath, cwd, fsService, signal, maxInspectBytes) {
  if (signal?.aborted) return null;

  if (fsService) {
    if (typeof fsService.readFile === 'function') {
      try {
        const content = await fsService.readFile(filePath, { cwd, signal });
        if (typeof content === 'string') {
          return Buffer.byteLength(content, 'utf8') <= maxInspectBytes ? content : null;
        }
      } catch {
        // Fall through
      }
    }
    if (typeof fsService.readText === 'function') {
      try {
        const target = typeof fsService.resolve === 'function'
          ? await fsService.resolve(filePath, { cwd, signal })
          : filePath;
        const content = await fsService.readText(target, signal);
        if (typeof content !== 'string') return null;
        return Buffer.byteLength(content, 'utf8') <= maxInspectBytes ? content : null;
      } catch {
        // Fall through to disk
      }
    }
  }

  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > maxInspectBytes) return null;
    if (signal?.aborted) return null;
    return await fs.readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Protect direct `read` calls against giant minified lines and blind large-file truncation
 * by enforcing single-line caps and appending a compact structural outline of unread tail lines.
 */
export function applyReadGuard(ctx, rawConfig = {}) {
  const config = ReadGuardConfig(rawConfig);
  if (!config.enabled) return null;

  const statsBySession = new WeakMap();
  const statsFor = session => {
    if (!session) return null;
    let s = statsBySession.get(session);
    if (!s) {
      s = { inspected: 0, linesTruncated: 0, outlinesInjected: 0 };
      statsBySession.set(session, s);
    }
    return s;
  };

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      statsBySession.set(session, { inspected: 0, linesTruncated: 0, outlinesInjected: 0 });
    }
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
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

    const session = exec.agent?.session;
    const stats = statsFor(session);
    if (stats) stats.inspected++;

    let changed = false;
    const updatedBlocks = baseBlocks.map(block => ({ ...block }));

    // 1. Single-line cap on text blocks (preserves DSH <content>...</content> wrapper if present)
    for (let i = 0; i < updatedBlocks.length; i++) {
      const block = updatedBlocks[i];
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const { prefix, body, suffix } = splitEnvelope(block.text);
      const truncatedBody = truncateLongLines(body, config.maxLineChars);
      if (truncatedBody !== body) {
        block.text = `${prefix}${truncatedBody}${suffix}`;
        changed = true;
        if (stats) stats.linesTruncated++;
      }
    }

    // 2. Blind-read tail outline injection (only when caller omitted both offset & limit and hit truncation)
    const args = exec.arguments ?? {};
    const isBlindRead = args.offset === undefined && args.limit === undefined && typeof args.file_path === 'string' && args.file_path.trim().length > 0;
    if (config.injectTailOutline && isBlindRead) {
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
          const fsService = (() => {
            try {
              return ctx.get('fs');
            } catch {
              return undefined;
            }
          })();

          const fullText = await readTargetSafely(args.file_path, cwd, fsService, exec.signal, config.maxInspectBytes);
          if (fullText !== null && !exec.signal?.aborted) {
            const totalLines = fullText.replace(/\r\n/g, '\n').split('\n').length;
            if (totalLines > trunc.endLine) {
              const outline = formatCodeOutline(fullText, {
                filePath: args.file_path,
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
      return statsFor(session) ?? { inspected: 0, linesTruncated: 0, outlinesInjected: 0 };
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
