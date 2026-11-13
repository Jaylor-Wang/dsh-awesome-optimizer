import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyPersistentEval, EVAL_PYTHON_TOOL, EVAL_NODE_TOOL, formatEvalOutput, StdioWorkerRunner } from '../src/persistent-eval/index.js';
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

  test('registers eval_python and eval_node tools in DSH tools catalog', () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, { enabled: true });

    assert.ok(registeredTools.has(EVAL_PYTHON_TOOL));
    assert.ok(registeredTools.has(EVAL_NODE_TOOL));

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    assert.equal(pyTool.name, EVAL_PYTHON_TOOL);
    assert.equal(pyTool.parameters.required[0], 'code');
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

  test('watchdog kills infinite loop and automatically restarts healthy worker', async () => {
    const { ctx, registeredTools } = createMockContext();
    // Arm with an ultra-short 300ms timeout for test speed
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      timeoutMs: 300
    });

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-timeout-1' };
    const execContext = { session: mockSession };

    // Trigger deliberate infinite loop
    const timeoutOut = await pyTool.execute({
      code: 'while True: pass'
    }, execContext);

    assert.ok(timeoutOut.includes('Execution timed out after 300ms'));
    assert.ok(timeoutOut.includes('terminated and will be restarted cleanly'));

    // Verify self-healing: subsequent invocation immediately succeeds!
    const healedOut = await pyTool.execute({
      code: '10 + 20'
    }, execContext);
    assert.equal(healedOut.trim(), '=> 30');
  });

  test('queued tasks recover cleanly when preceding task crashes or times out', async () => {
    const { ctx, registeredTools } = createMockContext();
    serviceInstance = applyPersistentEval(ctx, {
      enabled: true,
      timeoutMs: 250
    });

    const pyTool = registeredTools.get(EVAL_PYTHON_TOOL);
    const mockSession = { id: 'sess-queued-recovery' };
    const execContext = { session: mockSession };

    // Concurrently enqueue task 1 (hangs and gets killed) and task 2 (healthy)
    const p1 = pyTool.execute({ code: 'while True: pass' }, execContext);
    const p2 = pyTool.execute({ code: '"recovered second task"' }, execContext);

    const [out1, out2] = await Promise.all([p1, p2]);

    assert.ok(out1.includes('Execution timed out'));
    assert.equal(out2.trim(), '=> \'recovered second task\'');
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

    // Trigger turn/start event for another session
    const autoSession = { id: 'sess-turn-start' };
    const autoPyRunner = serviceInstance.pool.getPythonRunner(autoSession);
    assert.equal(autoPyRunner.isReady, false);

    ctx.emit('turn/start', { session: autoSession });
    // Allow microtask tick
    await new Promise(r => setTimeout(r, 100));
    assert.equal(autoPyRunner.isReady, true);
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
});
