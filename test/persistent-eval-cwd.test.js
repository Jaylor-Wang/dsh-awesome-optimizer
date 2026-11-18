import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPersistentEval, StdioWorkerRunner } from '../src/persistent-eval/index.js';
import { createTestRuntime, call } from './support/runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const kernels = [
  { name: 'python', command: 'python', args: ['-u', path.join(root, 'src/persistent-eval/workers/py_worker.py')], inspect: 'import os\n[CWD, os.getcwd()]', mark: 'marker = 73', read: 'marker', cleared: '"marker" not in globals()', delay: 'time.sleep(0.08)\n[CWD, os.getcwd()]', hang: 'while True: pass' },
  { name: 'node', command: 'node', args: [path.join(root, 'src/persistent-eval/workers/node_worker.mjs')], inspect: '[CWD, process.cwd()]', mark: 'globalThis.marker = 73', read: 'globalThis.marker', cleared: 'typeof globalThis.marker === "undefined"', delay: 'await new Promise(resolve => setTimeout(resolve, 80));\n[CWD, process.cwd()]', hang: 'while (true) {}' }
];

function workspace() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eval-cwd-'));
  const a = path.join(temp, '项目 A');
  const b = path.join(temp, '项目 B');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'en.json'), JSON.stringify({ hello: 'Hello', goodbye: 'Goodbye' }));
  fs.writeFileSync(path.join(a, 'zh.json'), JSON.stringify({ hello: '你好' }));
  return {
    a, b, missing: path.join(temp, 'missing'),
    async cleanup() {
      assert.equal(path.dirname(temp), os.tmpdir());
      assert.ok(path.basename(temp).startsWith('dsh-eval-cwd-'));
      await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  };
}

function context(initialDirectory) {
  const tools = new Map();
  const listeners = new Map();
  return {
    tools: { register: definition => tools.set(definition.name, definition), get: name => tools.get(name) },
    get(name) { return name === 'workingDirectory' ? { get: initialDirectory } : undefined; },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); }
  };
}

for (const kernel of kernels) {
  test(`${kernel.name} protocol synchronizes directories before reset/eval and preserves queued request order`, async t => {
    const dirs = workspace();
    const runner = new StdioWorkerRunner({ command: kernel.command, args: kernel.args });
    t.after(async () => { runner.destroy(); await dirs.cleanup(); });
    const evaluate = (code, options = {}) => runner.execute(code, options);
    assert.deepEqual((await evaluate(kernel.inspect, { cwd: dirs.a })).result, [dirs.a, dirs.a]);
    if (kernel.name === 'python') {
      const analysis = await evaluate('keys = {p.stem: set(json.loads(p.read_text(encoding="utf-8"))) for p in pathlib.Path(".").glob("*.json")}\nsorted(keys["en"] - keys["zh"])');
      assert.equal(analysis.success, true);
      assert.deepEqual(analysis.result, ['goodbye']);
    }
    await evaluate(kernel.mark);
    assert.deepEqual((await evaluate(kernel.inspect, { cwd: dirs.b })).result, [dirs.b, dirs.b]);
    assert.equal((await evaluate(kernel.read)).result, 73);

    for (const cwd of [dirs.missing, 'relative/path', '', 42]) {
      const failed = await evaluate(kernel.mark.replace('73', '999'), { cwd, reset: true });
      assert.equal(failed.success, false, `Expected cwd rejection for ${cwd}`);
      assert.ok(failed.error);
      assert.equal((await evaluate(kernel.read)).result, 73);
      assert.deepEqual((await evaluate(kernel.inspect)).result, [dirs.b, dirs.b]);
    }

    const failedReset = await evaluate('', { action: 'reset', cwd: dirs.missing });
    assert.equal(failedReset.success, false);
    assert.equal((await evaluate(kernel.read)).result, 73);
    const reset = await evaluate('', { action: 'reset', cwd: dirs.a });
    assert.equal(reset.success, true);
    assert.equal((await evaluate(kernel.cleared)).result, true);
    assert.deepEqual((await evaluate(kernel.inspect)).result, [dirs.a, dirs.a]);
    const inlineReset = await evaluate(kernel.inspect, { cwd: dirs.b, reset: true });
    assert.equal(inlineReset.success, true);
    assert.deepEqual(inlineReset.result, [dirs.b, dirs.b]);
    if (kernel.name === 'node') {
      const logged = await evaluate('console.log("after reset"); CWD', { reset: true, cwd: dirs.a });
      assert.equal(logged.stdout, 'after reset\n');
    }

    const results = await Promise.all([
      evaluate(kernel.delay, { cwd: dirs.a }),
      evaluate(kernel.inspect, { cwd: dirs.b })
    ]);
    assert.deepEqual(results.map(result => result.result), [[dirs.a, dirs.a], [dirs.b, dirs.b]]);
    const timedOut = await evaluate(kernel.hang, { cwd: dirs.b, timeoutMs: 50 });
    assert.equal(timedOut.success, false);
    assert.match(timedOut.error, /timed out/);
    assert.deepEqual((await evaluate(kernel.inspect, { cwd: dirs.b })).result, [dirs.b, dirs.b]);
  });

  test(`${kernel.name} tools track initial/session event cwd and restore it after worker cancellation`, async t => {
    const dirs = workspace();
    const a = { id: `${kernel.name}-session-A` };
    const b = { id: `${kernel.name}-session-B` };
    const initialDirectories = new Map([[a.id, dirs.a], [b.id, dirs.b]]);
    const ctx = context(session => initialDirectories.get(session.id));
    const service = applyPersistentEval(ctx, { enabled: true, python: kernel.name === 'python', node: kernel.name === 'node' });
    t.after(async () => { service.destroy(); await dirs.cleanup(); });
    const tool = ctx.tools.get(`eval_${kernel.name}`);
    const evaluate = (session, args, signal) => tool.execute(args, { agent: { session }, signal });
    await service.prewarm(a);
    const isAt = cwd => kernel.name === 'python'
      ? `import os\nCWD == ${JSON.stringify(cwd)} and os.getcwd() == ${JSON.stringify(cwd)}`
      : `CWD === ${JSON.stringify(cwd)} && process.cwd() === ${JSON.stringify(cwd)}`;
    const truth = '=> ' + (kernel.name === 'python' ? 'True' : 'true');
    assert.equal(await evaluate(a, { code: isAt(dirs.a) }), truth);
    assert.equal(await evaluate(b, { code: isAt(dirs.b) }), truth);
    await evaluate(a, { code: kernel.mark });

    ctx.emit('session/event', { id: a.id }, { type: 'working-directory/change', data: { cwd: dirs.b } });
    assert.equal(await evaluate(a, { code: isAt(dirs.b) }), truth);
    assert.equal(await evaluate(a, { code: kernel.read }), '=> 73');
    assert.equal(await evaluate(b, { code: kernel.cleared }), truth);
    assert.equal(await evaluate(a, { code: kernel.cleared, reset: true }), truth);
    assert.equal(await evaluate(a, { code: isAt(dirs.b) }), truth);
    await evaluate(a, { code: kernel.mark });

    ctx.emit('session/event', a, { type: 'working-directory/change', data: { cwd: dirs.missing } });
    const failed = await evaluate(a, { code: kernel.mark.replace('73', '999'), reset: true });
    assert.match(failed, /\[Error:/);
    ctx.emit('session/event', a, { type: 'working-directory/change', data: { cwd: dirs.b } });
    assert.equal(await evaluate(a, { code: kernel.read }), '=> 73');

    const runner = kernel.name === 'python' ? service.pool.getPythonRunner(a) : service.pool.getNodeRunner(a);
    const launches = runner.launchCount;
    const controller = new AbortController();
    const aborted = evaluate(a, { code: kernel.hang }, controller.signal);
    const abortCheck = assert.rejects(aborted, /workspace cancellation/);
    const timer = setTimeout(() => controller.abort(new Error('workspace cancellation')), 100);
    try { await abortCheck; } finally { clearTimeout(timer); }
    assert.equal(await evaluate(a, { code: isAt(dirs.b) }), truth);
    assert.equal(runner.launchCount, launches + 1);

    ctx.emit('session/disposed', a);
    ctx.emit('session/event', a, { type: 'session/start' });
    initialDirectories.set(a.id, dirs.a);
    assert.equal(await evaluate(a, { code: isAt(dirs.a) }), truth);
  });
}

test('official agent loop passes initial session cwd to both eval tools', async t => {
  const dirs = workspace();
  t.after(() => dirs.cleanup());
  const host = await createTestRuntime({
    workingDirectory: dirs.a,
    optimizerConfig: { persistentEval: { enabled: true, python: true, node: true } },
    script: [
      [call('py-cwd', 'eval_python', { code: 'pathlib.Path(".").resolve() == pathlib.Path(CWD) and pathlib.Path(CWD).name == "项目 A"' }), call('node-cwd', 'eval_node', { code: `CWD === process.cwd() && CWD.endsWith(${JSON.stringify(path.basename(dirs.a))})` })],
      [{ type: 'text', text: 'Done' }]
    ]
  });
  try {
    await host.run('Check workspace directories');
    const results = host.events.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0].text);
    assert.deepEqual(results, ['=> True', '=> true']);
  } finally {
    await host.dispose();
  }
});
