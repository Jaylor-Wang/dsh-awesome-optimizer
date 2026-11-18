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

const CONTEXT_OMITTED = '  ... [context omitted to fit byte budget]';
const EVIDENCE_ROW_BYTES = 192;

function windowLocation({ file, win }) {
  return `${file.displayPath}:${win.start}-${win.end}`;
}

function sliceHeader(task) {
  return `=== ${windowLocation(task)} ===`;
}

function sectionOverhead(header) {
  return byteLength(header) + byteLength(CONTEXT_OMITTED) + 4; // two newlines and a section separator
}

/** Estimate the minimum useful section from capped grep previews without reusing them as read results. */
export function readEvidenceBytes(task, maxLineChars) {
  let cheapest = EVIDENCE_ROW_BYTES;
  for (const number of task.win.matchedLines) {
    const preview = truncateLongLines(task.file.lines.get(number) ?? '', maxLineChars);
    cheapest = Math.min(cheapest, byteLength(`> ${number}: ${preview}`));
  }
  return sectionOverhead(sliceHeader(task)) + cheapest;
}

export function collectReadSlice(task, cleanText, maxLineChars, error) {
  if (error !== undefined) return { error: `=== ${windowLocation(task)} [READ ERROR] ===\n${error}` };
  const matched = new Set(task.win.matchedLines);
  const rows = truncateLongLines(cleanText, maxLineChars).split('\n').map(text => {
    const number = Number(text.match(/^(\d+):/)?.[1]);
    const hit = matched.has(number);
    return { number, hit, text: `${hit ? '>' : ' '} ${text}` };
  });
  const header = sliceHeader(task);
  return { header, rows, file: task.file, full: `${header}\n${rows.map(row => row.text).join('\n')}` };
}

/** Spend bytes on evidence across all slices before adding surrounding context. */
export function appendReadSlices(output, slices) {
  if (slices.length === 0) return;
  const fullBytes = slices.reduce((sum, slice) => sum + byteLength(slice.full ?? slice.error) + 2, -2);
  if (fullBytes <= output.remaining()) {
    for (const slice of slices) {
      output.append(slice.full ?? slice.error);
      for (const row of slice.rows ?? []) if (row.hit) slice.file.shown.add(row.number);
    }
    return;
  }

  output.reduced = true;
  let available = output.remaining() + 2; // charge each rendered section its separator
  const sections = slices.filter(slice => slice.rows).map(slice => ({ ...slice, selected: new Map(), bytes: 0 }));
  const hits = sections.flatMap(section => section.rows.filter(row => row.hit).map(row => ({ section, row })));
  const covered = new Set();
  function select({ section, row }, cap) {
    const previous = section.selected.get(row);
    const overhead = section.bytes === 0 ? sectionOverhead(section.header) : previous ? 0 : 1;
    const recovered = previous ? byteLength(previous) : 0;
    const text = clipUtf8(row.text, Math.min(cap, available - overhead + recovered));
    if (!text.startsWith(`> ${row.number}:`)) return false;
    const cost = overhead + byteLength(text) - recovered;
    available -= cost;
    section.bytes += cost;
    section.selected.set(row, text);
    for (const pattern of section.file.linePatterns.get(row.number) ?? []) covered.add(pattern);
    return true;
  }

  // Reserve a bounded representative for each pattern, preferring rows that cover several.
  const rejected = new Set();
  while (true) {
    let best;
    let bestGain = 0;
    for (const hit of hits) {
      if (rejected.has(hit) || hit.section.selected.has(hit.row)) continue;
      let gain = 0;
      for (const pattern of hit.section.file.linePatterns.get(hit.row.number) ?? []) {
        if (!covered.has(pattern)) gain++;
      }
      if (gain > bestGain) {
        best = hit;
        bestGain = gain;
      }
    }
    if (!best) break;
    if (!select(best, EVIDENCE_ROW_BYTES)) rejected.add(best);
  }

  // Keep read failures visible before optional rows or context consume the remainder.
  const errors = new Map();
  for (const slice of slices) {
    if (slice.error === undefined) continue;
    const text = clipUtf8(slice.error, Math.min(available - 2, 512));
    if (!text.includes('[READ ERROR]')) continue;
    errors.set(slice, text);
    available -= byteLength(text) + 2;
  }
  for (const hit of hits) select(hit, EVIDENCE_ROW_BYTES);
  for (const hit of hits) {
    if (hit.section.selected.has(hit.row)) select(hit, Infinity);
  }

  let sectionIndex = 0;
  for (const slice of slices) {
    if (!slice.rows) {
      output.append(errors.get(slice));
      continue;
    }
    const section = sections[sectionIndex++];
    if (section.selected.size === 0) continue;
    const fullCost = byteLength(section.full) + 2 - section.bytes;
    if (fullCost <= available && output.append(section.full)) {
      available -= fullCost;
      for (const row of section.rows) if (row.hit) section.file.shown.add(row.number);
      continue;
    }
    // Keep nearby context when a full slice cannot fit without displacing evidence.
    const neighbors = new Set();
    for (const [index, row] of section.rows.entries()) {
      if (!section.selected.has(row)) continue;
      for (const neighbor of [section.rows[index - 1], section.rows[index + 1]]) {
        if (neighbor && !neighbor.hit && Number.isFinite(neighbor.number)) neighbors.add(neighbor);
      }
    }
    for (const row of neighbors) {
      const cost = byteLength(row.text) + 1;
      if (cost > available) continue;
      section.selected.set(row, row.text);
      available -= cost;
    }
    const rows = section.rows.filter(row => section.selected.has(row));
    const compact = [section.header, ...rows.map(row => section.selected.get(row)), CONTEXT_OMITTED].join('\n');
    if (output.append(compact)) {
      for (const row of rows) if (row.hit) section.file.shown.add(row.number);
    }
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
