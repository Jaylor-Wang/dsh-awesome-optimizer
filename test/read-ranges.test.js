import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as ReadRanges from '../scripts/local-read-ranges.mjs';
import { applyCompositeTools } from '../src/composite-tools.js';

const load = async (require, name) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const require = createRequire(import.meta.url);
// Resolve the provider and observation policy from the same host as the linked tool registry.
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
const fakeFile = 'sample.txt';
const body = ['needle first', ...Array(13).fill('pad 中😀'), 'needle last', 'tail'].join('\r\n');
const ranges = [{ offset: 1, limit: 2 }, { offset: 14, limit: 3 }];
const text = result => result.content.map(block => block.text).join('\n');

async function fixture(t, { enabled, provider = true, readCaps = {}, real = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'optimizer-read-ranges-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  const events = [];
  const agent = { session: { header: { cwd }, append: (type, data) => events.push({ type, data }) } };
  ctx.provide('workingDirectory', { get: () => cwd, ensure: () => cwd });
  const initial = real ? `${body}\r\n${'padding for a second physical stream chunk\r\n'.repeat(2000)}` : body;
  let bytes = initial;
  let version = 'v1';
  const path = join(cwd, fakeFile);
  let opens = 0;
  const state = {};
  if (real) {
    const [{ default: LocalFs }, ToolFs, Policy] = await Promise.all([
      load(hostRequire, 'dsh-fs-local'), load(hostRequire, 'dsh-tool-fs'), load(hostRequire, 'dsh-fs-observation-policy')
    ]);
    await ctx.plugin(LocalFs, { cwd });
    await ctx.plugin(Policy);
    await ctx.plugin(ToolFs, { readImage: false, ...readCaps });
    await writeFile(path, initial, { flag: 'wx' });
    const stream = ctx.fs.streamText.bind(ctx.fs);
    ctx.fs.streamText = async (...args) => {
      opens++;
      const chunks = await stream(...args);
      return (async function* () {
        let first = true;
        for await (const chunk of chunks) {
          yield chunk;
          if (first) {
            first = false;
            await state.afterFirstChunk?.(Buffer.byteLength(chunk));
          }
        }
      })();
    };
  } else {
    ctx.provide('fs', {
      resolve: () => ({ targetKey: path, displayPath: path }),
      stat: () => ({ type: 'file', size: Buffer.byteLength(bytes), version }),
      async *streamText() {
        opens++;
        const end = bytes.indexOf('\n');
        yield bytes.slice(0, end);
        await state.afterFirstChunk?.();
        yield bytes.slice(end);
      }
    });
    ctx.tools.register({
      name: 'read', description: 'Native read fixture',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ offset, limit }) {
        opens++;
        return bytes.split('\r\n').slice(offset - 1, offset + limit - 1)
          .map((line, i) => `${offset + i}: ${line}`).join('\n');
      }
    });
  }
  ctx.tools.register({
    name: 'grep', description: 'Stable disjoint hits for the pilot fixture', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => `Found 2 matches\n\n${fakeFile}\nLine 1: needle first\nLine 15: needle last`
  });
  if (provider) await ctx.plugin(ReadRanges, { readStreamMinSize: 1, ...readCaps });
  applyCompositeTools(ctx, { ...(enabled === undefined ? {} : { experimentalReadRanges: enabled }), maxTotalBytes: 512, editBatch: false });
  const pipeline = new ToolExecutionPipeline(ctx);
  let id = 0;
  const observations = [];
  ctx.on('fs/observed', (_target, observation, exec) => observations.push({ observation, name: exec.name }));
  async function call(name, args, { signal = new AbortController().signal, nested = false } = {}) {
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal });
    try {
      const prepared = await pipeline.prepare({ name, arguments: args, agent, toolSet, signal, callId: `test-${++id}`,
        ...(nested ? { parent: {} } : {}) });
      return await pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared);
    } finally { toolSet.dispose(); }
  }
  return { ctx, state, path, call, initial, observations, events, opens: () => opens,
    find: options => call('find_and_read', { pattern: 'needle', contextLines: 1 }, options),
    grouped: options => call('optimizer_read_ranges', { file_path: fakeFile, ranges }, { nested: true, ...options }),
    modify: async next => { bytes = next; version = 'v2'; if (real) await writeFile(path, next); } };
}

const dispatched = host => host.events.filter(e => e.type === 'tool/ptc-dispatch').map(e => e.data);

test('pilot preserves window admission, order and bounded text, and falls back when off or unavailable', async t => {
  const baseline = await fixture(t);
  const unavailable = await fixture(t, { enabled: true, provider: false });
  const pilot = await fixture(t, { enabled: true });
  const expected = await baseline.find();
  assert.equal(expected.isError, false);
  assert.match(text(expected), /> 1: needle first/);
  assert.match(text(expected), /> 15: needle last/);
  for (const host of [unavailable, pilot]) assert.equal(text(await host.find()), text(expected));
  assert(Buffer.byteLength(text(expected)) <= 512);
  assert.equal(baseline.opens(), 2);
  assert.equal(unavailable.opens(), 2);
  assert.equal(pilot.opens(), 1);
  assert.deepEqual(dispatched(pilot).map(e => e.name), ['grep', 'optimizer_read_ranges']);
  assert.deepEqual(dispatched(pilot)[1].arguments.ranges, ranges);
});

test('pre-execute denial does not fall back and post-execute replacement does not leak raw windows', async t => {
  const host = await fixture(t, { enabled: true });
  const dispose = host.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'optimizer_read_ranges'
    ? { kind: 'deny', reason: 'Fixture read denied' } : next());
  assert.match(text(await host.find()), /Fixture read denied/);
  const maskDenial = host.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'optimizer_read_ranges'
    ? { kind: 'accept', content: [{ type: 'text', text: 'Read unavailable' }] } : next());
  const masked = text(await host.find());
  assert.match(masked, /Read unavailable/);
  assert.doesNotMatch(masked, /Fixture read denied/);
  maskDenial();
  assert.equal(host.opens(), 0);
  dispose();
  const direct = await host.call('optimizer_read_ranges', { file_path: fakeFile, ranges });
  assert.equal(direct.error.info.code, 'RANGES_NOT_ADMITTED');
  assert.equal(host.opens(), 0);
  host.ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name !== 'optimizer_read_ranges') return next();
    return { kind: 'accept', content: ranges.map(({ offset }) => ({ type: 'text', text: `${offset}: redacted` })) };
  });
  const output = text(await host.find());
  assert.match(output, /redacted/);
  assert.doesNotMatch(output, /needle first|needle last/);
  assert.equal(host.opens(), 1);
  assert(dispatched(host).every(e => e.name !== 'read'));
});

test('midstream write or abort never returns grouped content or publishes a version observation', async t => {
  const host = await fixture(t, { real: true, readCaps: { readStreamMinSize: 1 } });
  host.state.afterFirstChunk = async bytes => {
    assert(bytes > 0 && bytes < Buffer.byteLength(host.initial));
    await host.modify(host.initial.replace(/padding for a second physical stream chunk\r\n$/, 'new external tail\r\n'));
  };
  const stale = await host.grouped();
  assert.equal(stale.error.info.code, 'FS_STALE_VERSION');
  assert.equal(stale.value, undefined);
  assert.deepEqual(host.observations, []);
  const controller = new AbortController();
  host.state.afterFirstChunk = () => controller.abort();
  const aborted = await host.grouped({ signal: controller.signal });
  assert(aborted.isError);
  assert.match(aborted.error.info.code, /ABORTED/);
  assert.equal(aborted.value, undefined);
  assert.deepEqual(host.observations, []);
  assert.equal(host.opens(), 2);
});

test('native edit rejects an old grouped observation and succeeds after grouped reread', async t => {
  const host = await fixture(t, { real: true, readCaps: { readStreamMinSize: 1 } });
  const edit = { file_path: fakeFile, old_string: 'needle first', new_string: 'needle edited' };
  assert.equal((await host.call('edit', edit)).error.info.code, 'FS_NOT_OBSERVED');
  assert.equal((await host.grouped()).isError, false);
  const external = host.initial.replace('tail', 'new external tail');
  await host.modify(external);
  assert.equal((await host.call('edit', edit)).error.info.code, 'FS_STALE_VERSION');
  assert.deepEqual(await readFile(host.path), Buffer.from(external));
  const read = await host.grouped();
  assert.equal(read.isError, false);
  assert.equal(read.value.totalLines, 2016);
  assert.equal((await host.call('edit', edit)).isError, false);
  assert.deepEqual(await readFile(host.path), Buffer.from(external.replace(edit.old_string, edit.new_string)));
});
