import { Buffer } from 'node:buffer';
import { truncateLongLines } from './read-guard.js';

const byteLength = text => Buffer.byteLength(text, 'utf8');

export function clipUtf8(text, maxBytes, suffix = ' ... [truncated]') {
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes <= byteLength(suffix)) return '';
  const buffer = Buffer.from(text, 'utf8');
  let end = maxBytes - byteLength(suffix);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8') + suffix;
}

/** Reserve room for recovery indexes and a final omission notice. */
export class FindOutput {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.reserve = Math.min(2048, Math.floor(maxBytes / 3));
    this.parts = [];
    this.bytes = 0;
    this.reduced = false;
  }

  remaining() {
    return Math.max(0, this.maxBytes - this.reserve - this.bytes - (this.parts.length ? 2 : 0));
  }

  append(text) {
    if (!text) return true;
    if (byteLength(text) > this.remaining()) return false;
    this.bytes += byteLength(text) + (this.parts.length ? 2 : 0);
    this.parts.push(text);
    return true;
  }

  appendClipped(text, cap = this.remaining()) {
    const clipped = clipUtf8(text, Math.min(cap, this.remaining()));
    if (clipped !== text) this.reduced = true;
    return this.append(clipped);
  }

  finish(note = '') {
    this.reserve = 0;
    if (note) this.appendClipped(note);
    return this.parts.join('\n\n');
  }
}

export function searchStatus(text, meta, retainedCount) {
  const header = text.match(/^Found (\d+) of (\d+) matches\s*$/m);
  const recovery = text.match(/^\(?Full grep result stored at:[^\r\n]+/m)?.[0]?.replace(/\)$/, '')
    ?? text.match(/^\(?The complete result could not be saved[^\r\n]+/m)?.[0]?.replace(/\)$/, '')
    ?? '';
  const total = header ? Number(header[2]) : (Number.isFinite(meta?.total) ? meta.total : undefined);
  const truncated = Boolean(header || meta?.truncated || (total !== undefined && total > retainedCount));
  return { truncated, total, retained: header ? Number(header[1]) : retainedCount, recovery };
}

export function appendSearchNotices(output, runs) {
  const incomplete = runs.filter(run => run.result.isError || run.status.truncated);
  if (!incomplete.length) return;
  const summary = incomplete.map(run => `#${run.index + 1} ${run.result.isError ? 'failed' : 'truncated'}`).join(', ');
  output.append(`Search incomplete: ${summary}. Counts below cover retained matches only.`);
  const cap = Math.floor(Math.min(4096, output.remaining() / 2) / incomplete.length);
  for (const run of incomplete) {
    let detail;
    if (run.result.isError) {
      const message = run.result.error?.message || run.text || 'grep failed';
      detail = `Pattern #${run.index + 1} failed: ${message}`;
    } else {
      const counts = run.status.total === undefined ? 'partial results' : `${run.status.retained} of ${run.status.total} matches`;
      const recovery = run.status.recovery.includes('could not be saved')
        ? 'spill could not be saved; narrow search.'
        : (run.status.recovery || 'narrow search.');
      detail = `#${run.index + 1}: ${counts}; ${recovery}`;
    }
    output.appendClipped(detail, cap);
  }
}

/** Split chained merges before dispatch; each returned window contains a hit. */
export function splitWindows(windows, maxLines) {
  const bounded = [];
  for (const window of windows) {
    for (let start = window.start; start <= window.end; start += maxLines) {
      const end = Math.min(window.end, start + maxLines - 1);
      const matchedLines = window.matchedLines.filter(line => line >= start && line <= end);
      if (matchedLines.length) bounded.push({ start, end, matchedLines });
    }
  }
  return bounded;
}

export function appendSlice(output, task, cleanText, maxLineChars) {
  const matched = new Set(task.win.matchedLines);
  const rows = truncateLongLines(cleanText, maxLineChars).split('\n').map(text => {
    const line = text.match(/^(\d+):\s?(.*)$/);
    const number = line ? Number(line[1]) : undefined;
    return { number, text: `${matched.has(number) ? '>' : ' '} ${text}` };
  });
  const header = `=== ${task.file.displayPath}:${task.win.start}-${task.win.end} ===`;
  const full = `${header}\n${rows.map(row => row.text).join('\n')}`;
  if (output.append(full)) {
    for (const row of rows) if (matched.has(row.number)) task.file.shown.add(row.number);
    return;
  }

  output.reduced = true;
  const note = '  ... [context omitted to fit byte budget]';
  let block = header;
  const shown = [];
  for (const row of rows.filter(row => matched.has(row.number))) {
    const available = output.remaining() - byteLength(block) - byteLength(note) - 2;
    const text = clipUtf8(row.text, available);
    if (!text || !text.startsWith(`> ${row.number}:`)) break;
    block += `\n${text}`;
    shown.push(row.number);
    if (text !== row.text) break;
  }
  if (shown.length && output.append(`${block}\n${note}`)) {
    for (const line of shown) task.file.shown.add(line);
  }
}

export function appendMatchListing(output, files, maxLineChars) {
  for (const file of files) {
    const header = `=== ${file.displayPath} (${file.lines.size} matches) ===`;
    let block = header;
    const shown = [];
    for (const [line, text] of [...file.lines.entries()].sort((a, b) => a[0] - b[0])) {
      const row = `  ${line}: ${truncateLongLines(text, maxLineChars)}`;
      const available = output.remaining() - byteLength(block) - 1;
      const clipped = clipUtf8(row, available);
      if (!clipped || !clipped.startsWith(`  ${line}:`)) break;
      block += `\n${clipped}`;
      shown.push(line);
      if (clipped !== row) { output.reduced = true; break; }
    }
    if (shown.length && output.append(block)) {
      for (const line of shown) file.shown.add(line);
    }
  }
}

function compactLines(lines) {
  const runs = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && last[1] + 1 === line) last[1] = line;
    else runs.push([line, line]);
  }
  const text = runs.slice(0, 6).map(([start, end]) => start === end ? `L${start}` : `L${start}-${end}`).join(', ');
  return `${text}${runs.length > 6 ? ', ...' : ''}`;
}

export function finishFindOutput(output, files) {
  output.reserve = Math.min(128, Math.floor(output.maxBytes / 5));
  let missing = 0;
  let unindexed = 0;
  let hasIndex = false;
  for (const file of files) {
    const lines = [...file.lines.keys()].filter(line => !file.shown.has(line)).sort((a, b) => a - b);
    if (!lines.length) continue;
    missing += lines.length;
    const row = `${file.displayPath}: ${compactLines(lines)}`;
    const block = `${hasIndex ? '' : '--- Additional matches (index only) ---\n'}${row}`;
    if (output.append(block)) hasIndex = true;
    else unindexed++;
  }
  const note = missing || output.reduced
    ? `[find_and_read: ${missing} code match(es), ${unindexed} file index(es) omitted; narrow search or read by line.]`
    : '';
  return output.finish(note);
}
