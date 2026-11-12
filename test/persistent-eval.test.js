import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyPersistentEval, EVAL_PYTHON_TOOL, EVAL_NODE_TOOL, formatEvalOutput } from '../src/persistent-eval/index.js';

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
});
