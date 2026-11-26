import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import persistentEvalPlugin, {
  applyPersistentEval,
  DaemonPool,
  EVAL_PYTHON_TOOL,
  EVAL_NODE_TOOL,
  formatEvalOutput,
  StdioWorkerRunner,
  PY_WORKER_SCRIPT,
  NODE_WORKER_SCRIPT
} from '../src/persistent-eval/index.js';
import { createTestRuntime, call } from './support/runtime.js';
function createMockContext() {
  const registeredTools = new Map();
  const eventListeners = new Map();

  const ctx = {
    tools: {
      register(toolDef) {
        registeredTools.set(toolDef.name, toolDef);
      },
      get(name) {
        return registeredTools.get(name);
      }
    },
    on(event, handler) {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event).push(handler);
    },
    emit(event, ...args) {
      const handlers = eventListeners.get(event) || [];
      for (const h of handlers) h(...args);
    }
  };

  return { ctx, registeredTools, eventListeners };
}

describe('Persistent Eval Integration & Watchdog (Phase 2 & 3)', () => {
  let serviceInstance;

  afterEach(() => {
    if (serviceInstance) {
      serviceInstance.destroy();
      serviceInstance = null;
    }
  });

  test('registers and prewarms both workers on the official loop with default settings', async () => {
    const host = await createTestRuntime();
    try {
      for (const name of [EVAL_NODE_TOOL, EVAL_PYTHON_TOOL]) {
        const tool = host.ctx.tools.get(name, host.agent);
        assert.equal(tool?.name, name);
        assert.deepEqual(tool.parameters.required, ['code']);
      }
      await host.run('Run a turn without calling either eval tool');
      const service = host.ctx.get('persistentEval');
      const runners = service.pool.runnersBySession.get(host.agent.session.id);
      assert.equal(runners?.node?.launchCount, 1);
      assert.equal(runners?.python?.launchCount, 1);
      await Promise.all([runners.node.ensureStarted(), runners.python.ensureStarted()]);
    } finally {
      await host.dispose();
    }
  });

  test('explicit opt-out skips tool registration and worker lifecycle hooks', async () => {
    const { ctx, registeredTools, eventListeners } = createMockContext();
    assert.equal(applyPersistentEval(ctx, { enabled: false, python: true, node: true }), null);
    assert.equal(registeredTools.size, 0);
    assert.equal(eventListeners.size, 0);
    const host = await createTestRuntime({ optimizerConfig: { persistentEval: { enabled: false } } });
    try {
      await host.run('Run with persistent eval disabled');
      assert.equal(host.ctx.get('persistentEval'), undefined);
      assert.equal(host.ctx.tools.get(EVAL_NODE_TOOL, host.agent), undefined);
      assert.equal(host.ctx.tools.get(EVAL_PYTHON_TOOL, host.agent), undefined);
    } finally {
      await host.dispose();
    }
  });

  test('eval_python executes stateful calculations across turns', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true });

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-py-1' };
    const execContext = { session: mockSession };

    // Turn 1: define variables and function
    const out1 = await pyTool.execute({
      code: `
legs = [10, 20, 30]
def sum_legs():
    return sum(legs)
`
    }, execContext);
    assert.ok(out1.includes('<Executed successfully with no output>') || out1 === '');

    // Turn 2: compute result using previous definition
    const out2 = await pyTool.execute({
      code: 'sum_legs()'
    }, execContext);
    assert.equal(out2.trim(), '=> 60');

    // Turn 3: print output
    const out3 = await pyTool.execute({
      code: 'print("Calculated legs sum:", sum_legs())'
    }, execContext);
    assert.ok(out3.includes('Calculated legs sum: 60'));
  });

  test('eval_node executes stateful calculations and supports top-level await', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true });

    const nodeTool = registeredTools.get(EVAL_NODE_TOOL);
    const mockSession = { id: 'sess-node-1' };
    const execContext = { session: mockSession };

    // Turn 1: define global state
    await nodeTool.execute({
      code: 'globalThis.offset = 42;'
    }, execContext);

    // Turn 2: compute with await
    const out2 = await nodeTool.execute({
      code: `
const fetched = await Promise.resolve(100);
fetched + globalThis.offset;
`
    }, execContext);
    assert.equal(out2.trim(), '=> 142');
  });

  test('watchdog reports the configured timeout and restarts the worker for a queued task', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      timeoutMs: 250
    });

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-queued-recovery' };
    const execContext = { session: mockSession };
    const runner = serviceInstance.pool.getPythonRunner(mockSession);
    assert.equal(runner.launchCount, 0);

    // Submit both tasks before the watchdog terminates the first worker.
    const timeout = assert.rejects(pyTool.execute({ code: 'while True: pass' }, execContext), {
      code: 'PERSISTENT_EVAL_FAILED',
      message: /Execution timed out after 250ms.*terminated and will be restarted cleanly/
    });
    const p2 = pyTool.execute({ code: '"recovered second task"' }, execContext);

    const [, out2] = await Promise.all([timeout, p2]);
    assert.equal(out2.trim(), '=> \'recovered second task\'');
    assert.equal(runner.launchCount, 2);
  });

  test('worker failures enter the official error channel and repeated failures trip the circuit breaker', async () => {
    const host = await createTestRuntime({
      script: [
        [call('py-error', EVAL_PYTHON_TOOL, { code: 'raise ValueError("python failure")' })],
        ...['node-first', 'node-second', 'node-blocked'].map(id => [
          call(id, EVAL_NODE_TOOL, { code: 'throw new Error("node failure")' })
        ]),
        [call('node-ok', EVAL_NODE_TOOL, { code: '6 * 7' })],
        [{ type: 'text', text: 'Done.' }]
      ]
    });
    try {
      await host.run();
      assert.deepEqual(host.errors, []);
      const results = host.events.filter(event => event.type === 'tool/result').map(event => event.data);
      assert.equal(results.length, 5);
      for (const [index, message] of [/python failure/, /node failure/, /node failure/].entries()) {
        const result = results[index];
        assert.equal(result.message.isError, true);
        assert.equal(result.error.code, 'PERSISTENT_EVAL_FAILED');
        assert.match(result.message.content[0].text, message);
      }
      assert.equal(results[3].message.isError, true);
      assert.match(results[3].message.content[0].text, /NO_PROGRESS/);
      assert.equal(results[4].message.isError, false);
      assert.equal(results[4].message.content[0].text, '=> 42');
      assert.equal(host.telemetry.getSummary(host.agent.session).failedToolCalls, 4);
    } finally {
      await host.dispose();
    }
  });

  test('anti-dumping guard truncates oversized output payloads', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      maxOutputBytes: 128
    });

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-dump-1' };
    const execContext = { session: mockSession };

    // Emit 500 characters
    const out = await pyTool.execute({
      code: 'print("X" * 500)'
    }, execContext);

    assert.ok(out.includes('[Output truncated: stdout exceeded 128 bytes.'));
  });

  test('worker stdout and stderr obey true UTF-8 byte limits for Python and Node', async t => {
    const cases = [
      {
        command: 'python',
        args: ['-u', PY_WORKER_SCRIPT],
        code: 'import sys; print("中😀" * 100); print("错误😀" * 100, file=sys.stderr)'
      },
      {
        command: 'node',
        args: [NODE_WORKER_SCRIPT],
        code: 'console.log("中😀".repeat(100)); console.error("错误😀".repeat(100));'
      }
    ];

    for (const item of cases) {
      const runner = new StdioWorkerRunner({ ...item, maxOutputBytes: 64 });
      t.after(() => runner.destroy());
      const response = await runner.execute(item.code);
      assert.ok(Buffer.byteLength(response.stdout, 'utf8') <= 64);
      assert.ok(Buffer.byteLength(response.stderr, 'utf8') <= 64);
      assert.doesNotMatch(response.stdout, /\uFFFD/);
      assert.doesNotMatch(response.stderr, /\uFFFD/);
      assert.match(response.stdout, /Output truncated/);
      assert.match(response.stderr, /Output truncated/);
    }
  });

  test('stdio runner bounds external stderr accumulation by bytes', async t => {
    const script = [
      "const readline = require('node:readline');",
      "process.stdout.write(JSON.stringify({status:'ready',pid:process.pid}) + '\\n');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      "const req = JSON.parse(line); process.stderr.write('中'.repeat(10000));",
      "process.stdout.write(JSON.stringify({id:req.id,success:true,stdout:'',stderr:'',result:null}) + '\\n'); });"
    ].join('');
    const runner = new StdioWorkerRunner({ command: 'node', args: ['-e', script], maxOutputBytes: 64 });
    t.after(() => runner.destroy());
    const response = await runner.execute('ignored');
    assert.ok(Buffer.byteLength(response.stderr, 'utf8') <= 64);
    assert.doesNotMatch(response.stderr, /\uFFFD/);
    assert.match(response.stderr, /Output truncated/);
  });

  test('stdio runner converts unexpected worker termination into a bounded failure and can be disposed', async t => {
    const script = "process.stdout.write(JSON.stringify({status:'ready',pid:process.pid}) + '\\n'); setTimeout(() => process.exit(17), 30);";
    const runner = new StdioWorkerRunner({ command: 'node', args: ['-e', script], timeoutMs: 1000 });
    t.after(() => runner.destroy());
    const response = await runner.execute('ignored');
    assert.equal(response.success, false);
    assert.match(response.error, /exited unexpectedly/);
    assert.equal(runner.isReady, false);
    runner.destroy();
    assert.equal(runner.isDestroyed, true);
  });

  test('formatEvalOutput handles various corner cases', () => {
    assert.equal(formatEvalOutput(null), 'No response returned from kernel.');
    assert.equal(
      formatEvalOutput({ success: true, stdout: '', stderr: '', result: null }),
      '<Executed successfully with no output>'
    );
    assert.equal(
      formatEvalOutput({ success: false, stdout: '', stderr: '', error: 'Syntax error' }),
      '[Error: Syntax error]'
    );
  });

  test('prewarm boots workers ahead of time and turn/start triggers prewarm', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      python: true,
      node: true
    });

    const mockSession = { id: 'sess-prewarm-test' };
    const pyRunner = serviceInstance.pool.getPythonRunner(mockSession);
    assert.equal(pyRunner.isReady, false);

    // Call service.prewarm()
    await serviceInstance.prewarm(mockSession);
    assert.equal(pyRunner.isReady, true);

    // Calling execute now hits already-ready worker
    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const out = await pyTool.execute({ code: 'math.sqrt(16)' }, { session: mockSession });
    assert.equal(out, '=> 4.0');

    const autoSession = { id: 'sess-turn-start' };
    ctx.emit('session/event', autoSession, { type: 'turn/start', data: { turn: 1 } });
    const runners = serviceInstance.pool.runnersBySession.get(autoSession.id);
    assert.equal(runners?.python?.launchCount, 1);
    assert.equal(runners?.node?.launchCount, 1);
    // Join the start already triggered by the event, then confirm neither worker relaunched.
    await Promise.all([runners.python.ensureStarted(), runners.node.ensureStarted()]);
    assert.equal(runners.python.launchCount, 1);
    assert.equal(runners.node.launchCount, 1);
  });

  test('formatEvalOutput produces zero-token-waste ultra compact output', () => {
    // Pure expression evaluation (no stdout): single line, no blank lines
    assert.equal(formatEvalOutput({ success: true, stdout: '', stderr: '', result: 42, resultRepr: '42' }), '=> 42');

    // Output with trailing newlines is trimmed
    assert.equal(formatEvalOutput({ success: true, stdout: 'Calculated successfully\n\n\n', stderr: '', result: null }), 'Calculated successfully');

    // Both stdout and result
    assert.equal(formatEvalOutput({ success: true, stdout: 'Info\n', stderr: '', result: 100, resultRepr: '100' }), 'Info\n=> 100');

    // Floating point precision noise is compacted
    assert.equal(formatEvalOutput({ success: true, stdout: '', stderr: '', result: 0.1 + 0.2, resultRepr: '0.30000000000000004' }), '=> 0.3');
  });

  test('StdioWorkerRunner rejects ensureStarted and execute immediately when binary fails to spawn', async () => {
    const brokenRunner = new StdioWorkerRunner({
      command: 'definitely-nonexistent-binary-dsh-test-xyz',
      args: []
    });

    await assert.rejects(
      () => brokenRunner.execute('1 + 1'),
      err => err instanceof Error && /ENOENT|spawn|exited/i.test(err.message)
    );
    brokenRunner.destroy();
  });

  test('startup timeout clears shared waiters, terminates the child, and allows the next call to restart', async t => {
    // A Node process reading its script from stdin stays alive without sending ready.
    const runner = new StdioWorkerRunner({ command: process.execPath, args: ['-'], timeoutMs: 120 });
    const abort = new AbortController();
    const cancelled = runner.execute('1 + 1', { signal: abort.signal });
    const child = runner.child;
    const closed = once(child, 'close');
    t.after(async () => {
      runner.destroy();
      await closed;
    });
    const prewarm = runner.ensureStarted();
    const execute = runner.execute('2 + 2');
    const timedOut = /Worker startup timed out after 120ms/;
    const checks = Promise.all([
      assert.rejects(cancelled, { name: 'AbortError' }),
      assert.rejects(prewarm, timedOut),
      assert.rejects(execute, timedOut)
    ]);
    abort.abort();
    assert.equal(runner.readyWaiters.length, 2);
    assert.equal(runner.child, child);
    assert.equal(runner.launchCount, 1);
    await checks;
    assert.equal(runner.child, null);
    assert.equal(runner.startupTimer, null);
    assert.equal(runner.readyWaiters.length, 0);
    await closed;

    runner.args = [NODE_WORKER_SCRIPT];
    runner.timeoutMs = 2000;
    const response = await runner.execute('3 + 4');
    assert.equal(response.success, true);
    assert.equal(response.result, 7);
    assert.equal(runner.launchCount, 2);
    assert.equal(runner.startupTimer, null);
  });

  test('cancelling the only startup waiter terminates an unready worker', async t => {
    const runner = new StdioWorkerRunner({ command: process.execPath, args: ['-'], timeoutMs: 5000 });
    const controller = new AbortController();
    const started = runner.execute('1 + 1', { signal: controller.signal });
    const closed = once(runner.child, 'close');
    t.after(async () => {
      runner.destroy();
      await closed;
    });

    controller.abort();
    await assert.rejects(started, { name: 'AbortError' });
    assert.equal(runner.child, null);
    assert.equal(runner.startupTimer, null);
    assert.equal(runner.readyWaiters.length, 0);
    await closed;
  });

  test('StdioWorkerRunner rejects pending startup waiters when destroyed', async () => {
    const runner = new StdioWorkerRunner({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)']
    });
    const startPromise = runner.ensureStarted();
    runner.destroy();
    await assert.rejects(
      () => startPromise,
      /Worker runner has been destroyed/
    );
  });

  test('applyPersistentEval destroys session workers on session/disposed', async () => {
    const { ctx } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true });
    const session = { id: 'sess-dispose-test' };

    const nodeRunner = serviceInstance.pool.getNodeRunner(session);
    await nodeRunner.ensureStarted();
    assert.equal(nodeRunner.isDestroyed, false);

    ctx.emit('session/disposed', session);
    assert.equal(nodeRunner.isDestroyed, true);
    assert.throws(() => serviceInstance.pool.getNodeRunner(session), /Session workers have been destroyed/);

    ctx.emit('session/event', session, { type: 'session/start' });
    assert.doesNotThrow(() => serviceInstance.pool.getNodeRunner(session));
  });

  test('official dsh-agent-loop hits prewarmed session worker via exec.agent.session and isolates sessions', async () => {
    const hostA = await createTestRuntime({
      optimizerConfig: {
        persistentEval: { enabled: true, python: true, node: true }
      },
      script: [
        [
          call('c1', 'eval_python', { code: 'secret_val = 777' }),
          call('c2', 'eval_node', { code: 'globalThis.nodeTag = "session-A"' })
        ],
        [
          call('c3', 'eval_python', { code: 'secret_val' }),
          call('c4', 'eval_node', { code: 'globalThis.nodeTag' })
        ],
        [{ type: 'text', text: 'Done A' }]
      ]
    });

    const hostB = await createTestRuntime({
      optimizerConfig: {
        persistentEval: { enabled: true, python: true, node: true }
      },
      script: [
        [
          call('b1', 'eval_python', { code: '"secret_val" in globals()' }),
          call('b2', 'eval_node', { code: 'typeof globalThis.nodeTag' })
        ],
        [{ type: 'text', text: 'Done B' }]
      ]
    });

    try {
      await hostA.run('Session A persistent eval');
      const evalA = hostA.ctx.get('persistentEval');
      assert.equal(evalA.pool.runnersBySession.has('__global__'), false);
      assert.equal(evalA.pool.runnersBySession.has(hostA.agent.session.id), true);
      assert.equal(evalA.pool.getPythonRunner(hostA.agent.session).launchCount, 1);
      assert.equal(evalA.pool.getNodeRunner(hostA.agent.session).launchCount, 1);

      const resultsA = hostA.events.filter(e => e.type === 'tool/result').map(e => e.data.message.content[0].text);
      assert.equal(resultsA[2], '=> 777');
      assert.equal(resultsA[3], "=> 'session-A'");

      await hostB.run('Session B isolated');
      const resultsB = hostB.events.filter(e => e.type === 'tool/result').map(e => e.data.message.content[0].text);
      assert.equal(resultsB[0], '=> False');
      assert.equal(resultsB[1], "=> 'undefined'");
    } finally {
      await hostA.dispose();
      await hostB.dispose();
    }
  });

  test('multiple sessions execute concurrently with isolated workers and dispose independently', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true, python: true, node: true });
    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const nodeTool = registeredTools.get(EVAL_NODE_TOOL);
    const sessionA = { id: 'sess-concurrent-A' };
    const sessionB = { id: 'sess-concurrent-B' };

    const [pythonA, pythonB, nodeA, nodeB] = await Promise.all([
      pyTool.execute({ code: 'import time\ntime.sleep(0.08)\nsession_value = "A"\nsession_value' }, { agent: { session: sessionA } }),
      pyTool.execute({ code: 'import time\ntime.sleep(0.08)\nsession_value = "B"\nsession_value' }, { agent: { session: sessionB } }),
      nodeTool.execute({ code: 'await new Promise(r => setTimeout(r, 80));\nglobalThis.sessionValue = "A";\nglobalThis.sessionValue' }, { agent: { session: sessionA } }),
      nodeTool.execute({ code: 'await new Promise(r => setTimeout(r, 80));\nglobalThis.sessionValue = "B";\nglobalThis.sessionValue' }, { agent: { session: sessionB } })
    ]);

    assert.equal(pythonA.trim(), "=> 'A'");
    assert.equal(pythonB.trim(), "=> 'B'");
    assert.equal(nodeA.trim(), "=> 'A'");
    assert.equal(nodeB.trim(), "=> 'B'");
    assert.notEqual(serviceInstance.pool.getPythonRunner(sessionA), serviceInstance.pool.getPythonRunner(sessionB));
    assert.notEqual(serviceInstance.pool.getNodeRunner(sessionA), serviceInstance.pool.getNodeRunner(sessionB));

    const runnerA = serviceInstance.pool.getPythonRunner(sessionA);
    ctx.emit('session/event', sessionA, { type: 'session/disposed' });
    assert.equal(runnerA.isDestroyed, true);
    assert.equal(serviceInstance.pool.runnersBySession.has(sessionA.id), false);
    ctx.emit('session/event', sessionA, { type: 'turn/start', data: { turn: 2 } });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(serviceInstance.pool.runnersBySession.has(sessionA.id), false);

    ctx.emit('session/disposed', sessionB);
    assert.equal(serviceInstance.pool.runnersBySession.has(sessionB.id), false);
  });

  test('AbortSignal immediately cancels in-flight eval_python without waiting for watchdog timeout and recovers cleanly', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      timeoutMs: 10000
    });
    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-abort-inflight' };
    await serviceInstance.prewarm(mockSession);

    const ac = new AbortController();
    const started = performance.now();
    setTimeout(() => ac.abort(new Error('User cancelled')), 120);

    await assert.rejects(
      () => pyTool.execute({ code: 'while True: pass' }, { agent: { session: mockSession }, signal: ac.signal }),
      /User cancelled/
    );
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 3000, `Expected prompt abort under 3000ms, got ${elapsedMs.toFixed(1)}ms`);

    // Clean recovery on next execution in the same session
    const recovered = await pyTool.execute({ code: '21 * 2' }, { agent: { session: mockSession } });
    assert.equal(recovered.trim(), '=> 42');
  });

  test('AbortSignal cancels queued and starting tasks without killing healthy active task', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true, timeoutMs: 5000 });
    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-abort-queue' };
    await serviceInstance.prewarm(mockSession);

    const activePromise = pyTool.execute(
      { code: 'import time; time.sleep(0.15); "active-ok"' },
      { agent: { session: mockSession } }
    );

    const queuedAc = new AbortController();
    const queuedPromise = pyTool.execute(
      { code: '"should-not-run"' },
      { agent: { session: mockSession }, signal: queuedAc.signal }
    );
    // Wait until queuedPromise enters pendingQueue behind activePromise
    await new Promise(r => setTimeout(r, 20));
    queuedAc.abort(new Error('Queued abort'));
    await assert.rejects(() => queuedPromise, /Queued abort/);
    const activeResult = await activePromise;
    assert.equal(activeResult.trim(), "=> 'active-ok'");

    // Also abort during startup wait
    const slowRunner = new StdioWorkerRunner({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)']
    });
    const startAc = new AbortController();
    setTimeout(() => startAc.abort(new Error('Startup abort')), 60);
    await assert.rejects(
      () => slowRunner.execute('1 + 1', { signal: startAc.signal }),
      /Startup abort/
    );
    slowRunner.destroy();
  });

  test('eval_python returns NaN and Infinity cleanly through StdioWorkerRunner without timing out', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true, timeoutMs: 2000 });
    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const session = { id: 'sess-py-nan' };

    assert.equal(await pyTool.execute({ code: 'float("nan")' }, { session }), '=> nan');
    assert.equal(await pyTool.execute({ code: 'float("inf")' }, { session }), '=> inf');
    assert.equal(await pyTool.execute({ code: '1 + 1' }, { session }), '=> 2');
  });

  test('workers sanitize sensitive credential and DSH_* env vars by default with opt-out and explicit override', async t => {
    const prev = {
      DSH_INTERNAL_TEST: process.env.DSH_INTERNAL_TEST,
      TEST_MOCK_API_KEY: process.env.TEST_MOCK_API_KEY,
      TEST_SAFE_OPT_VAR: process.env.TEST_SAFE_OPT_VAR
    };
    process.env.DSH_INTERNAL_TEST = 'internal-dsh-secret';
    process.env.TEST_MOCK_API_KEY = 'sk-test-secret';
    process.env.TEST_SAFE_OPT_VAR = 'safe-visible-value';
    t.after(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const sanitizedPy = new StdioWorkerRunner({
      command: 'python',
      args: ['-u', PY_WORKER_SCRIPT],
      env: { EXPLICIT_TOKEN_OVERRIDE: 'explicit-ok' }
    });
    const sanitizedNode = new StdioWorkerRunner({
      command: 'node',
      args: [NODE_WORKER_SCRIPT]
    });
    const unsanitizedNode = new StdioWorkerRunner({
      command: 'node',
      args: [NODE_WORKER_SCRIPT],
      sanitizeEnv: false
    });
    t.after(() => {
      sanitizedPy.destroy();
      sanitizedNode.destroy();
      unsanitizedNode.destroy();
    });

    const pyRes = await sanitizedPy.execute(
      'import os; [os.environ.get("DSH_INTERNAL_TEST"), os.environ.get("TEST_MOCK_API_KEY"), os.environ.get("TEST_SAFE_OPT_VAR"), os.environ.get("EXPLICIT_TOKEN_OVERRIDE")]'
    );
    assert.equal(pyRes.success, true);
    assert.deepEqual(pyRes.result, [null, null, 'safe-visible-value', 'explicit-ok']);

    const nodeRes = await sanitizedNode.execute(
      '[process.env.DSH_INTERNAL_TEST ?? null, process.env.TEST_MOCK_API_KEY ?? null, process.env.TEST_SAFE_OPT_VAR ?? null]'
    );
    assert.equal(nodeRes.success, true);
    assert.deepEqual(nodeRes.result, [null, null, 'safe-visible-value']);

    const rawNodeRes = await unsanitizedNode.execute(
      '[process.env.DSH_INTERNAL_TEST ?? null, process.env.TEST_MOCK_API_KEY ?? null]'
    );
    assert.equal(rawNodeRes.success, true);
    assert.deepEqual(rawNodeRes.result, ['internal-dsh-secret', 'sk-test-secret']);
  });

  test('requireShellTool gates eval_python and eval_node admission when bash is restricted away', async () => {
    const host = await createTestRuntime();
    try {
      const restrictDispose = host.agent.ctx.tools.restrict({ deny: ['bash'] });
      try {
        const restrictedSet = await host.ctx.tools.resolve({
          agent: host.agent,
          signal: new AbortController().signal
        });
        try {
          assert.equal(host.ctx.tools.executable('bash', host.agent, restrictedSet), undefined);
          assert.equal(host.ctx.tools.executable(EVAL_PYTHON_TOOL, host.agent, restrictedSet), undefined);
          assert.equal(host.ctx.tools.executable(EVAL_NODE_TOOL, host.agent, restrictedSet), undefined);
        } finally {
          restrictedSet.dispose();
        }
        await host.run('Check model tool list without bash');
        const advertised = host.requests[0].tools.map(t => t.name);
        assert.equal(advertised.includes('bash'), false);
        assert.equal(advertised.includes(EVAL_PYTHON_TOOL), false);
        assert.equal(advertised.includes(EVAL_NODE_TOOL), false);
      } finally {
        restrictDispose();
      }
    } finally {
      await host.dispose();
    }

    const optOutHost = await createTestRuntime({
      optimizerConfig: { persistentEval: { enabled: true, requireShellTool: false } }
    });
    try {
      const restrictDispose = optOutHost.agent.ctx.tools.restrict({ deny: ['bash'] });
      try {
        const set = await optOutHost.ctx.tools.resolve({
          agent: optOutHost.agent,
          signal: new AbortController().signal
        });
        try {
          assert.equal(optOutHost.ctx.tools.executable('bash', optOutHost.agent, set), undefined);
          assert.ok(optOutHost.ctx.tools.executable(EVAL_PYTHON_TOOL, optOutHost.agent, set));
          assert.ok(optOutHost.ctx.tools.executable(EVAL_NODE_TOOL, optOutHost.agent, set));
        } finally {
          set.dispose();
        }
      } finally {
        restrictDispose();
      }
    } finally {
      await optOutHost.dispose();
    }
  });

  test('DaemonPool bounds primitive disposedKeys and tracks anonymous object sessions via WeakSet', () => {
    const pool = new DaemonPool({ maxDisposedKeys: 3 });
    try {
      for (let i = 1; i <= 5; i++) {
        pool.destroySession({ id: `s-${i}` });
      }
      assert.equal(pool.disposedKeys.size, 3);
      assert.deepEqual([...pool.disposedKeys], ['s-3', 's-4', 's-5']);

      const anonSession = {};
      pool.destroySession(anonSession);
      assert.equal(pool.disposedKeys.size, 3);
      assert.throws(() => pool.getNodeRunner(anonSession), /Session workers have been destroyed/);
      assert.equal(pool.reviveSession(anonSession), true);
      assert.doesNotThrow(() => pool.getNodeRunner(anonSession));
    } finally {
      pool.destroyAll();
    }
    assert.equal(pool.disposedKeys.size, 0);
  });

  test('persistent-eval subpath exports a standard Cordis plugin interface', () => {
    assert.equal(persistentEvalPlugin.name, 'agent-optimizer-persistent-eval');
    assert.deepEqual(persistentEvalPlugin.inject, ['tools']);
    const { ctx } = createMockContext();
    let providedName = null;
    let providedService = null;
    ctx.provide = (k, v) => { providedName = k; providedService = v; };
    persistentEvalPlugin.apply(ctx, { enabled: true });
    assert.equal(providedName, 'persistentEval');
    assert.ok(providedService?.pool instanceof DaemonPool);
    providedService.destroy();
  });

  test('StdioWorkerRunner reports per-call timeoutMs accurately and real executionTimeMs on fast crash', async t => {
    const pyRunner = new StdioWorkerRunner({
      command: 'python',
      args: ['-u', PY_WORKER_SCRIPT],
      timeoutMs: 5000
    });
    const crashScript = "process.stdout.write(JSON.stringify({status:'ready',pid:process.pid}) + '\\n'); setTimeout(() => process.exit(9), 20);";
    const crashRunner = new StdioWorkerRunner({
      command: 'node',
      args: ['-e', crashScript],
      timeoutMs: 5000
    });
    t.after(() => {
      pyRunner.destroy();
      crashRunner.destroy();
    });

    const timeoutRes = await pyRunner.execute('while True: pass', { timeoutMs: 80 });
    assert.equal(timeoutRes.success, false);
    assert.match(timeoutRes.error, /Execution timed out after 80ms/);

    const crashRes = await crashRunner.execute('ignored');
    assert.equal(crashRes.success, false);
    assert.ok(crashRes.executionTimeMs < 2000, `Expected real elapsed time < 2000ms, got ${crashRes.executionTimeMs}ms`);
  });

  test('DaemonPool uses process.execPath, StdioWorkerRunner bounds raw results & handles stdin EPIPE, and applyPersistentEval tolerates throwing workingDirectory', async t => {
    const pool = new DaemonPool();
    t.after(() => pool.destroyAll());
    const nodeRunner = pool.getNodeRunner({ id: 'exec-path-session' });
    assert.equal(nodeRunner.command, process.execPath);

    // Defense-in-depth: StdioWorkerRunner truncates oversized result/resultRepr even from custom workers
    const hugeResultScript = [
      "const readline = require('node:readline');",
      "process.stdout.write(JSON.stringify({status:'ready',pid:process.pid}) + '\\n');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      "const req = JSON.parse(line);",
      "process.stdout.write(JSON.stringify({id:req.id,success:true,stdout:'',stderr:'',result:{blob:'中'.repeat(500)},resultRepr:'中'.repeat(500)}) + '\\n'); });"
    ].join('');
    const hugeRunner = new StdioWorkerRunner({ command: process.execPath, args: ['-e', hugeResultScript], maxOutputBytes: 64 });
    t.after(() => hugeRunner.destroy());
    const bounded = await hugeRunner.execute('ignored');
    assert.equal(bounded.success, true);
    assert.ok(Buffer.byteLength(bounded.resultRepr, 'utf8') <= 64);
    assert.ok(Buffer.byteLength(String(bounded.result), 'utf8') <= 64);
    assert.doesNotMatch(bounded.resultRepr, /\uFFFD/);

    // Worker closing stdin immediately must not crash host with unhandled EPIPE
    const epipeScript = "process.stdout.write(JSON.stringify({status:'ready',pid:process.pid}) + '\\n'); process.stdin.destroy(); setTimeout(() => process.exit(0), 200);";
    const epipeRunner = new StdioWorkerRunner({ command: process.execPath, args: ['-e', epipeScript], timeoutMs: 1000 });
    t.after(() => epipeRunner.destroy());
    await epipeRunner.ensureStarted();
    const epipeRes = await epipeRunner.execute('x'.repeat(65536));
    assert.equal(epipeRes.success, false);
    assert.match(epipeRes.error, /exited unexpectedly|timed out/i);

    // applyPersistentEval must not fail when ctx.get('workingDirectory') throws
    const { ctx, registeredTools } = createMockContext();
    ctx.get = key => {
      if (key === 'workingDirectory') throw new Error('workingDirectory unavailable');
      return undefined;
    };
    const svc = applyPersistentEval(ctx, { enabled: true, python: false, node: true });
    t.after(() => svc?.destroy());
    const nodeTool = registeredTools.get(EVAL_NODE_TOOL);
    const out = await nodeTool.execute({ code: '19 + 23' }, { session: { id: 'throwing-cwd-session' } });
    assert.equal(out, '=> 42');
  });
});
