import { HarnessError } from '@deepseek-ai/dsh-llm';

export const name = 'local-read-ranges-pilot';
export const inject = ['tools', 'fs', 'workingDirectory'];

const positive = value => Number.isSafeInteger(value) && value > 0;
const windowArgs = {
  type: 'object', additionalProperties: false, required: ['offset', 'limit'],
  properties: { offset: { type: 'integer' }, limit: { type: 'integer' } }
};

async function scan(chunks, windows, maxChars, maxBytes, signal) {
  let line = 0;
  let pending = '';
  let hasText = false;
  const wantsLine = win => !win.capped && line + 1 >= win.offset && line + 1 < win.offset + win.limit;
  function append(chunk, start, end) {
    if (pending.length < maxChars + 2 && end > start && windows.some(wantsLine)) {
      pending += chunk.slice(start, Math.min(end, start + maxChars + 2 - pending.length));
    }
  }
  function finish() {
    const wanted = windows.filter(wantsLine);
    line++;
    if (wanted.length) {
      const raw = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      const text = raw.length > maxChars
        ? `${raw.substring(0, maxChars)}... (line truncated to ${maxChars} chars)` : raw;
      // Detach kept text from the provider chunk.
      const row = `${line}: ${Buffer.from(text, 'utf16le').toString('utf16le')}`;
      const bytes = Buffer.byteLength(text, 'utf8');
      for (const win of wanted) {
        const next = win.bytes + bytes + Number(win.rows.length > 0);
        if (next > maxBytes) win.capped = true;
        else {
          win.bytes = next;
          win.rows.push(row);
        }
      }
    }
    pending = '';
    hasText = false;
  }
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    let start = 0;
    let end = chunk.indexOf('\n', start);
    while (end !== -1) {
      append(chunk, start, end);
      finish();
      start = end + 1;
      end = chunk.indexOf('\n', start);
    }
    append(chunk, start, chunk.length);
    if (start < chunk.length) hasText = true;
  }
  if (hasText) finish();
  signal.throwIfAborted();
  return line;
}

// Loading this adapter opts the host into applying its policies to optimizer_read_ranges.
export function apply(ctx, { readLimit = 2000, readMaxLineLength = 2000, readMaxBytes = 50 * 1024,
  readStreamMinSize = 10 * 1024 * 1024 } = {}) {
  if (![readLimit, readMaxLineLength, readMaxBytes, readStreamMinSize].every(positive)) {
    throw new TypeError('Local range-read limits must be positive safe integers.');
  }
  ctx.tools.register({
    name: 'optimizer_read_ranges',
    description: 'Local pilot for reading several line windows in one file. Used by find_and_read.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['file_path', 'ranges'],
      properties: { file_path: { type: 'string' }, ranges: { type: 'array', minItems: 2, maxItems: 8, items: windowArgs } }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['totalLines', 'windows'], properties: {
        totalLines: { type: 'integer' },
        windows: { type: 'array', items: { type: 'string' } }
      } },
      render: (_args, value) => value.windows.map(text => ({ type: 'text', text }))
    },
    isConcurrencySafe: () => true,
    async execute({ file_path, ranges }, exec) {
      const { agent, signal } = exec;
      if (!agent || exec.parent === undefined || !ctx.tools.executable('read', agent, exec.toolSet)) {
        throw new HarnessError('Multi-window reads require an admitted native read and a composite call.', 'RANGES_NOT_ADMITTED');
      }
      if (!file_path.trim() || ranges.some(({ offset, limit }) =>
        !positive(offset) || !positive(limit) || limit > readLimit || !positive(offset + limit))) {
        throw new HarnessError('Invalid file path or line range.', 'INVALID_READ_RANGES');
      }
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      const target = await ctx.fs.resolve(file_path, { cwd, signal });
      const before = await ctx.fs.stat(target, signal);
      if (before?.type !== 'file' || before.version === undefined) {
        throw new HarnessError('Multi-window reads require a versioned regular file.', 'RANGES_UNSUPPORTED_FILE');
      }
      const chunks = before.size === undefined || before.size >= readStreamMinSize
        ? await ctx.fs.streamText(target, signal) : [await ctx.fs.readText(target, signal)];
      const windows = ranges.map(range => ({ ...range, rows: [], bytes: 0, capped: false }));
      const totalLines = await scan(chunks, windows, readMaxLineLength, readMaxBytes, signal);
      const current = await ctx.fs.resolve(file_path, { cwd, signal });
      const after = await ctx.fs.stat(current, signal);
      signal.throwIfAborted();
      if (current.targetKey !== target.targetKey || after?.type !== 'file' || after.version !== before.version) {
        throw new HarnessError('File changed during the multi-window read. Read it again.', 'FS_STALE_VERSION');
      }
      if (windows.some(win => win.offset > Math.max(1, totalLines))) {
        throw new HarnessError('A requested window begins after the end of the file. Search again.', 'FS_NOT_FOUND');
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: before.version }, exec);
      return { totalLines, windows: windows.map(win => win.rows.join('\n')) };
    }
  });
  ctx.provide('optimizerReadRanges', Object.freeze({ version: 1 }));
}
