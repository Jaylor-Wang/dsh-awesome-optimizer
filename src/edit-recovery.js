import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const EditRecoveryConfig = z.object({
  enabled: z.boolean().default(true),
  contextLines: z.number().step(1).min(1).max(30).default(6),
  maxSnippetLines: z.number().step(1).min(5).max(50).default(20),
  maxInspectBytes: z.number().step(1).min(4096).max(4 * 1024 * 1024).default(524288),
  maxHintBytes: z.number().step(1).min(256).max(16384).default(2048),
  maxMultiMatchLocations: z.number().step(1).min(1).max(10).default(3)
});

const SKIP_ERROR_CODES = new Set([
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'APPROVAL_UNAVAILABLE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'INVALID_EDIT_BATCH_ARGS',
  'EDIT_BATCH_LIMIT_EXCEEDED'
]);

const DENIAL_OR_MISSING_RE = /(?:\[runtime-policy\]|NO_PROGRESS|ENOENT|EACCES|EPERM|EISDIR|no such file|does not exist on disk|permission denied|sandbox|approval|requires approval|aborted|cancelled|canceled|blocked by)/i;
const MATCH_FAILURE_RE = /(?:old_string|not found|no match|did not match|does not match|couldn't find|could not find|unable to find|not present|multiple|appears \d+ times|found \d+ match|unique|replace_all|ambiguous|mismatch)/i;

/**
 * Determine whether an edit error represents a content-matching/uniqueness failure
 * (and NOT a sandbox, permission, missing-file, or policy denial).
 */
export function isEditMatchFailure(errorMessage, errorCode) {
  if (errorCode && SKIP_ERROR_CODES.has(errorCode)) return false;
  if (typeof errorMessage !== 'string' || !errorMessage.trim()) return false;
  if (DENIAL_OR_MISSING_RE.test(errorMessage)) return false;
  return MATCH_FAILURE_RE.test(errorMessage);
}

function splitNormalizedLines(text) {
  return text.split(/\r?\n/);
}

function normalizeLineText(line) {
  return line.replace(/\s+/g, ' ').trim();
}

function extractTokens(text) {
  const tokens = text.match(/[A-Za-z0-9_$]+|[\u4e00-\u9fff]+/g);
  if (tokens && tokens.length >= 2) return tokens;
  const compact = text.replace(/\s+/g, '');
  if (compact.length <= 3) return compact ? [compact] : [];
  const shingles = [];
  for (let i = 0; i <= compact.length - 3; i++) {
    shingles.push(compact.slice(i, i + 3));
  }
  return shingles;
}

function detectIndentStyle(lines) {
  let tabs = 0;
  let spaces = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('\t')) tabs++;
    else if (/^ {2,}/.test(line)) spaces++;
  }
  if (tabs > spaces * 2 && tabs >= 2) return 'tabs';
  if (spaces > tabs * 2 && spaces >= 2) return 'spaces';
  return null;
}

function findExactOccurrences(content, needle, maxLocations = 3) {
  if (!needle) return { count: 0, locations: [] };
  const locations = [];
  let count = 0;
  let pos = 0;
  let lastLinePos = 0;
  let currentLine = 1;

  while (true) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    if (locations.length < maxLocations) {
      for (let i = lastLinePos; i < idx; i++) {
        if (content.charCodeAt(i) === 10) currentLine++;
      }
      lastLinePos = idx;
      const needleLineBreaks = (needle.match(/\n/g) || []).length;
      locations.push({
        startLine: currentLine,
        endLine: currentLine + needleLineBreaks
      });
    }
    pos = idx + Math.max(1, needle.length);
  }
  return { count, locations };
}

/**
 * Locate the best matching region in `content` for a failed `oldString`.
 */
export function findBestEditMatch(content, oldString, options = {}) {
  if (typeof content !== 'string' || typeof oldString !== 'string' || !oldString) {
    return { kind: 'no-close-match', totalLines: 0 };
  }

  const maxMultiMatchLocations = options.maxMultiMatchLocations ?? 3;
  const exact = findExactOccurrences(content, oldString, maxMultiMatchLocations);
  if (exact.count > 1) {
    return {
      kind: 'multiple-matches',
      count: exact.count,
      locations: exact.locations,
      totalLines: splitNormalizedLines(content).length
    };
  }

  const contentLines = splitNormalizedLines(content);
  const queryLines = splitNormalizedLines(oldString);
  const queryNormLines = queryLines.map(normalizeLineText);
  const nonEmptyQueryLines = queryNormLines
    .map((norm, idx) => ({ norm, idx }))
    .filter(item => item.norm.length > 0);

  if (nonEmptyQueryLines.length === 0) {
    return { kind: 'no-close-match', totalLines: contentLines.length };
  }

  const contentNormLines = contentLines.map(normalizeLineText);
  const fileIndent = detectIndentStyle(contentLines);
  const queryIndent = detectIndentStyle(queryLines);
  const hasCrlfInFile = content.includes('\r\n');
  const hasCrlfInQuery = oldString.includes('\r\n');

  const indentNotes = [];
  if (fileIndent && queryIndent && fileIndent !== queryIndent) {
    indentNotes.push(`file uses ${fileIndent} indentation whereas old_string uses ${queryIndent}`);
  }
  if (hasCrlfInFile && !hasCrlfInQuery && oldString.includes('\n')) {
    indentNotes.push('file uses CRLF (\\r\\n) line endings');
  }

  // 1. Check contiguous line-normalized match (handles indentation / trailing-space drift)
  const qLen = queryNormLines.length;
  for (let start = 0; start <= contentNormLines.length - qLen; start++) {
    let allEqual = true;
    for (let j = 0; j < qLen; j++) {
      if (contentNormLines[start + j] !== queryNormLines[j]) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) {
      return {
        kind: 'whitespace-mismatch',
        startLine: start + 1,
        endLine: start + qLen,
        score: 1,
        notes: indentNotes.length > 0 ? indentNotes : ['whitespace/indentation differs from file'],
        totalLines: contentLines.length
      };
    }
  }

  // 2. Anchor-weighted line voting for partially changed multi-line blocks
  const lineIndex = new Map();
  for (let i = 0; i < contentNormLines.length; i++) {
    const norm = contentNormLines[i];
    if (!norm) continue;
    let list = lineIndex.get(norm);
    if (!list) {
      list = [];
      lineIndex.set(norm, list);
    }
    list.push(i);
  }

  const candidateScores = new Map();
  let maxPossibleLineWeight = 0;
  for (const { norm, idx: qOffset } of nonEmptyQueryLines) {
    const hits = lineIndex.get(norm);
    const weight = 1 / (1 + (hits ? Math.log2(1 + hits.length) : 0));
    maxPossibleLineWeight += weight;
    if (!hits || hits.length > 64) continue;
    for (const fileIdx of hits) {
      // Preserve signed offset so unrelated negative alignments do not collide at line 0.
      const candidateStart = fileIdx - qOffset;
      candidateScores.set(candidateStart, (candidateScores.get(candidateStart) ?? 0) + weight);
    }
  }

  let bestStart = null;
  let bestLineScore = 0;
  for (const [start, score] of candidateScores.entries()) {
    const normalized = maxPossibleLineWeight > 0 ? score / maxPossibleLineWeight : 0;
    if (normalized > bestLineScore) {
      bestLineScore = normalized;
      bestStart = start;
    }
  }

  if (bestLineScore >= 0.34 && bestStart !== null) {
    const clampedStart = Math.max(0, bestStart);
    return {
      kind: 'fuzzy-match',
      startLine: clampedStart + 1,
      endLine: Math.min(contentLines.length, Math.max(clampedStart + 1, bestStart + qLen)),
      score: bestLineScore,
      notes: indentNotes,
      totalLines: contentLines.length
    };
  }

  // 3. Token-rarity sliding window fallback (handles single-line edits or modified identifiers)
  const queryTokens = Array.from(new Set(extractTokens(oldString)));
  if (queryTokens.length === 0) {
    return { kind: 'no-close-match', totalLines: contentLines.length };
  }

  const tokenSet = new Set(queryTokens);
  const tokenDocFreq = new Map();
  const lineTokenSets = contentLines.map(line => {
    const lineTokens = extractTokens(line);
    const matched = new Set();
    for (const tok of lineTokens) {
      if (tokenSet.has(tok) && !matched.has(tok)) {
        matched.add(tok);
        tokenDocFreq.set(tok, (tokenDocFreq.get(tok) ?? 0) + 1);
      }
    }
    return matched;
  });

  const tokenWeights = new Map();
  let totalWeight = 0;
  for (const tok of queryTokens) {
    const freq = tokenDocFreq.get(tok) ?? 0;
    const w = freq > 0 ? 1 / Math.log2(2 + freq) : 1;
    tokenWeights.set(tok, w);
    totalWeight += w;
  }

  const windowSize = Math.max(1, Math.min(qLen, 12, contentLines.length));
  const activeCounts = new Map();
  let windowScore = 0;
  let bestTokenStart = 0;
  let bestTokenScore = 0;

  for (let i = 0; i < contentLines.length; i++) {
    for (const tok of lineTokenSets[i]) {
      const prev = activeCounts.get(tok) ?? 0;
      if (prev === 0) windowScore += tokenWeights.get(tok) ?? 0;
      activeCounts.set(tok, prev + 1);
    }
    if (i >= windowSize) {
      const leaving = lineTokenSets[i - windowSize];
      for (const tok of leaving) {
        const nextCount = (activeCounts.get(tok) ?? 1) - 1;
        activeCounts.set(tok, nextCount);
        if (nextCount === 0) windowScore -= tokenWeights.get(tok) ?? 0;
      }
    }
    if (i >= windowSize - 1) {
      const ratio = totalWeight > 0 ? windowScore / totalWeight : 0;
      if (ratio > bestTokenScore) {
        bestTokenScore = ratio;
        bestTokenStart = i - windowSize + 1;
      }
    }
  }

  if (bestTokenScore < 0.25) {
    return { kind: 'no-close-match', totalLines: contentLines.length };
  }

  return {
    kind: 'fuzzy-match',
    startLine: bestTokenStart + 1,
    endLine: Math.min(contentLines.length, bestTokenStart + windowSize),
    score: bestTokenScore,
    notes: indentNotes,
    totalLines: contentLines.length
  };
}

function formatNumberedWindow(lines, startLine, endLine, maxLineChars = 240) {
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const width = String(to).length;
  const out = [];
  for (let lineNo = from; lineNo <= to; lineNo++) {
    const raw = lines[lineNo - 1].replace(/\r$/, '');
    const clipped = raw.length > maxLineChars
      ? `${raw.slice(0, maxLineChars)}... [+${raw.length - maxLineChars} chars]`
      : raw;
    out.push(`${String(lineNo).padStart(width, ' ')} | ${clipped}`);
  }
  return out.join('\n');
}

function clampWindowToLineBudget(startLine, endLine, totalLines, contextLines, maxSnippetLines) {
  let from = Math.max(1, startLine - contextLines);
  let to = Math.min(totalLines, endLine + contextLines);
  if (to - from + 1 <= maxSnippetLines) {
    return { from, to };
  }
  const spanLen = endLine - startLine + 1;
  if (spanLen >= maxSnippetLines) {
    return { from: startLine, to: Math.min(totalLines, startLine + maxSnippetLines - 1) };
  }
  const extra = maxSnippetLines - spanLen;
  const before = Math.floor(extra / 2);
  from = Math.max(1, startLine - before);
  to = Math.min(totalLines, from + maxSnippetLines - 1);
  if (to - from + 1 < maxSnippetLines) {
    from = Math.max(1, to - maxSnippetLines + 1);
  }
  return { from, to };
}

function clipUtf8ToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function trimToMaxBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  let suffix = `\n... [context truncated at ${maxBytes} bytes]`;
  if (Buffer.byteLength(suffix, 'utf8') >= maxBytes) {
    suffix = '\n... [truncated]';
  }
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= maxBytes) {
    return clipUtf8ToBytes(text, maxBytes);
  }
  const budget = maxBytes - suffixBytes;
  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const sep = kept.length > 0 ? 1 : 0;
    if (used + sep + lineBytes <= budget) {
      kept.push(line);
      used += sep + lineBytes;
    } else {
      break;
    }
  }
  if (kept.length === 0) {
    const clippedFirst = clipUtf8ToBytes(lines[0] ?? '', budget);
    return clippedFirst ? `${clippedFirst}${suffix}` : clipUtf8ToBytes(text, maxBytes);
  }
  return `${kept.join('\n')}${suffix}`;
}

/**
 * Build a concise, line-numbered recovery hint for a failed edit on `content`.
 */
export function buildEditFailureHint(content, oldString, options = {}) {
  const contextLines = options.contextLines ?? 6;
  const maxSnippetLines = options.maxSnippetLines ?? 20;
  const maxHintBytes = options.maxHintBytes ?? 2048;
  const maxMultiMatchLocations = options.maxMultiMatchLocations ?? 3;
  const filePath = options.filePath || 'target file';

  const match = findBestEditMatch(content, oldString, { maxMultiMatchLocations });
  const lines = splitNormalizedLines(content);

  if (match.kind === 'multiple-matches') {
    const locSummary = match.locations
      .map(loc => (loc.startLine === loc.endLine ? `${loc.startLine}` : `${loc.startLine}-${loc.endLine}`))
      .join(', ');
    const moreSuffix = match.count > match.locations.length ? `, ... (${match.count} total)` : '';
    const snippets = match.locations.map((loc, idx) => {
      const from = Math.max(1, loc.startLine - 1);
      const to = Math.min(lines.length, loc.endLine + 1);
      return `Match #${idx + 1} (lines ${from}-${to}):\n${formatNumberedWindow(lines, from, to)}`;
    });
    const text = [
      `[edit-recovery] '${filePath}' contains ${match.count} exact matches (lines ${locSummary}${moreSuffix}). Pass replace_all=true or include surrounding lines to target one uniquely:`,
      ...snippets
    ].join('\n');
    return trimToMaxBytes(text, maxHintBytes);
  }

  if (match.kind === 'no-close-match') {
    return `[edit-recovery] No close match for old_string in '${filePath}' (${match.totalLines} lines). Re-read the target region before retrying.`;
  }

  const { from, to } = clampWindowToLineBudget(
    match.startLine,
    match.endLine,
    lines.length,
    contextLines,
    maxSnippetLines
  );

  const label = match.kind === 'whitespace-mismatch'
    ? `Exact match after whitespace/indentation normalization at lines ${match.startLine}-${match.endLine}`
    : `Closest match near lines ${match.startLine}-${match.endLine}`;
  const noteText = match.notes?.length ? ` (${match.notes.join('; ')})` : '';
  const hint = [
    `[edit-recovery] ${label} in '${filePath}'${noteText}. Copy exact lines ${from}-${to} below:`,
    formatNumberedWindow(lines, from, to)
  ].join('\n');
  return trimToMaxBytes(hint, maxHintBytes);
}

const UNAVAILABLE_FS = Object.freeze({});

async function readBoundedLocalFile(resolvedPath, signal, maxBytes) {
  let handle;
  try {
    handle = await fs.open(resolvedPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || signal?.aborted) return null;
    const chunks = [];
    let size = 0;
    const chunkSize = Math.min(65536, Math.max(stat.size + 1, 4096));
    while (size <= maxBytes) {
      if (signal?.aborted) return null;
      const toRead = Math.min(chunkSize, maxBytes + 1 - size);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) return null;
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    if (signal?.aborted || size > maxBytes) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readTargetForRecovery(filePath, cwd, fsService, signal, maxInspectBytes) {
  if (!filePath || typeof filePath !== 'string' || signal?.aborted) return null;

  if (fsService) {
    // A service failure is authoritative; never bypass sandbox or cancellation through local disk.
    let target;
    if (typeof fsService.resolve === 'function') {
      try {
        target = await fsService.resolve(filePath, { cwd, signal });
      } catch {
        return null;
      }
      if (signal?.aborted) return null;
      if (typeof fsService.stat === 'function') {
        try {
          const info = await fsService.stat(target, signal);
          if (signal?.aborted) return null;
          if (info !== undefined) {
            if (info.type !== undefined && info.type !== 'file') return null;
            if (Number.isFinite(info.size) && (info.size < 0 || info.size > maxInspectBytes)) return null;
          }
        } catch {
          return null;
        }
      }
    }

    if (typeof fsService.readBytes === 'function') {
      try {
        const bytes = await fsService.readBytes(target ?? filePath, signal, maxInspectBytes);
        if (signal?.aborted || !bytes || bytes.byteLength > maxInspectBytes) return null;
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    }

    if (typeof fsService.streamText === 'function') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of await fsService.streamText(target ?? filePath, signal)) {
          if (signal?.aborted || typeof chunk !== 'string') return null;
          size += Buffer.byteLength(chunk, 'utf8');
          if (size > maxInspectBytes) return null;
          chunks.push(chunk);
        }
        return chunks.join('');
      } catch {
        return null;
      }
    }

    if (typeof fsService.readFile === 'function') {
      try {
        const content = await fsService.readFile(filePath, { cwd, signal, encoding: 'utf8' });
        if (signal?.aborted || typeof content !== 'string') return null;
        return Buffer.byteLength(content, 'utf8') <= maxInspectBytes ? content : null;
      } catch {
        return null;
      }
    }

    if (typeof fsService.readText === 'function') {
      try {
        const content = await fsService.readText(target ?? filePath, signal);
        if (signal?.aborted || typeof content !== 'string') return null;
        return Buffer.byteLength(content, 'utf8') <= maxInspectBytes ? content : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Standalone hosts without an fs service may use a bounded local inspection.
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
  return readBoundedLocalFile(resolved, signal, maxInspectBytes);
}

/**
 * Mount `tools/post-execute` enrichment so failed `edit` (and `edit_batch` sub-call)
 * invocations automatically return numbered nearby context without an extra `read` turn.
 */
export function applyEditRecovery(ctx, rawConfig = {}) {
  const config = EditRecoveryConfig(rawConfig);
  if (!config.enabled) return null;

  const statsBySession = new WeakMap();
  const statsFor = session => {
    if (!session) return null;
    let s = statsBySession.get(session);
    if (!s) {
      s = { inspected: 0, hintsAttached: 0, skipped: 0 };
      statsBySession.set(session, s);
    }
    return s;
  };

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      statsBySession.set(session, { inspected: 0, hintsAttached: 0, skipped: 0 });
    }
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (exec?.name !== 'edit' || !result?.isError || exec.signal?.aborted) {
      return decision;
    }

    const args = exec.arguments;
    if (!args || typeof args.file_path !== 'string' || typeof args.old_string !== 'string' || !args.old_string) {
      return decision;
    }

    const decisionText = decision?.kind === 'block'
      ? (decision.feedback ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      : null;
    const baseMessage = decisionText
      || result.error?.message
      || result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
      || '';
    const errorCode = decision?.kind === 'block' ? (decision.info?.code ?? result.error?.info?.code) : result.error?.info?.code;
    const session = exec.agent?.session;
    const stats = statsFor(session);
    if (!isEditMatchFailure(baseMessage, errorCode)) {
      if (stats) stats.skipped++;
      return decision;
    }

    if (stats) stats.inspected++;

    let fsService;
    try {
      fsService = ctx.get ? ctx.get('fs') : undefined;
    } catch {
      // An unavailable/denied service is not permission to bypass it.
      fsService = UNAVAILABLE_FS;
    }
    let cwd = '';
    try {
      const cwdService = ctx.get ? ctx.get('workingDirectory') : undefined;
      cwd = cwdService?.get?.(session) ?? '';
    } catch {
      cwd = '';
    }

    const content = await readTargetForRecovery(
      args.file_path,
      cwd,
      fsService,
      exec.signal,
      config.maxInspectBytes
    );
    if (content === null || exec.signal?.aborted) {
      if (stats) stats.skipped++;
      return decision;
    }

    const hint = buildEditFailureHint(content, args.old_string, {
      filePath: args.file_path,
      contextLines: config.contextLines,
      maxSnippetLines: config.maxSnippetLines,
      maxHintBytes: config.maxHintBytes,
      maxMultiMatchLocations: config.maxMultiMatchLocations
    });
    if (!hint) return decision;

    if (stats) stats.hintsAttached++;
    const enriched = baseMessage ? `${baseMessage}\n\n${hint}` : hint;
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: enriched }],
      ...(result.error?.info ? { info: result.error.info } : {})
    };
  });

  return {
    getStats(session) {
      const s = session ? statsBySession.get(session) : null;
      return s ? { ...s } : { inspected: 0, hintsAttached: 0, skipped: 0 };
    }
  };
}

export const name = 'agent-optimizer-edit-recovery';
export const inject = ['tools'];
export const Config = EditRecoveryConfig;
export function apply(ctx, config = {}) {
  const service = applyEditRecovery(ctx, config);
  if (service) ctx.provide('editRecovery', service);
}
export default { name, inject, Config, apply };
