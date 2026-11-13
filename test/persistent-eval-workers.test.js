import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PY_WORKER_PATH = path.resolve(__dirname, '../src/persistent-eval/workers/py_worker.py');
const NODE_WORKER_PATH = path.resolve(__dirname, '../src/persistent-eval/workers/node_worker.mjs');

/**
 * Lightweight test driver helper that wraps a worker process into a Promise-based client.
 */
function launchWorker(command, args) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false
  });

  const pendingQueue = [];
  let isReady = false;
  let readyResolve = null;
  const readyPromise = new Promise(resolve => {
    readyResolve = resolve;
  });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.status === 'ready' && !isReady) {
        isReady = true;
        readyResolve(parsed);
        return;
      }
      if (pendingQueue.length > 0) {
        const { resolve } = pendingQueue.shift();
        resolve(parsed);
      }
    } catch (err) {
      if (pendingQueue.length > 0) {
        const { reject } = pendingQueue.shift();
        reject(err);
      }
    }
  });

  let stderrOutput = '';
  child.stderr.on('data', chunk => {
    stderrOutput += chunk.toString('utf-8');
  });

  return {
    ready: readyPromise,
    send(payload) {
      return new Promise((resolve, reject) => {
        pendingQueue.push({ resolve, reject });
        const line = JSON.stringify(payload) + '\n';
        child.stdin.write(line, 'utf-8');
      });
    },
    kill() {
      child.kill('SIGKILL');
    },
    getStderr: () => stderrOutput
  };
}

describe('Persistent Eval Workers (Phase 1)', () => {
  describe('Python Worker (py_worker.py)', () => {
    let pyClient;

    test('should start and send ready signal', async () => {
      pyClient = launchWorker('python', ['-u', PY_WORKER_PATH]);
      const readyMsg = await pyClient.ready;
      assert.equal(readyMsg.status, 'ready');
      assert.ok(typeof readyMsg.pid === 'number');
    });

    test('should respond to ping action', async () => {
      const res = await pyClient.send({ id: 'py-ping', action: 'ping' });
      assert.equal(res.id, 'py-ping');
      assert.equal(res.status, 'pong');
      assert.equal(res.success, true);
    });

    test('should evaluate expression and capture return value', async () => {
      const res = await pyClient.send({ id: 'py-eval-1', code: '12 + 30' });
      assert.equal(res.success, true);
      assert.equal(res.result, 42);
      assert.ok(res.executionTimeMs >= 0);
    });

    test('should capture stdout from print statements', async () => {
      const res = await pyClient.send({ id: 'py-print', code: 'print("Hello from Python Worker!")' });
      assert.equal(res.success, true);
      assert.equal(res.stdout, 'Hello from Python Worker!\n');
      assert.equal(res.result, null);
    });

    test('should retain global state across turns', async () => {
      // Turn 1: define variables and import module
      const res1 = await pyClient.send({
        id: 'py-state-1',
        code: `
import math
radius = 5
def circle_area(r):
    return math.pi * (r ** 2)
area = circle_area(radius)
`
      });
      assert.equal(res1.success, true);

      // Turn 2: read variable and call previously defined function
      const res2 = await pyClient.send({
        id: 'py-state-2',
        code: 'round(area, 2)'
      });
      assert.equal(res2.success, true);
      assert.equal(res2.result, 78.54);

      // Turn 3: call with another value
      const res3 = await pyClient.send({
        id: 'py-state-3',
        code: 'round(circle_area(10), 2)'
      });
      assert.equal(res3.success, true);
      assert.equal(res3.result, 314.16);
    });

    test('should handle syntax and runtime errors gracefully without crashing worker', async () => {
      const res = await pyClient.send({ id: 'py-err-1', code: '1 / 0' });
      assert.equal(res.success, false);
      assert.equal(res.error, 'division by zero');
      assert.ok(res.stderr.includes('ZeroDivisionError'));

      // Verify worker remains alive and state intact
      const aliveCheck = await pyClient.send({ id: 'py-alive', code: 'radius * 2' });
      assert.equal(aliveCheck.success, true);
      assert.equal(aliveCheck.result, 10);
    });

    test('should support UTF-8 unicode (Chinese text)', async () => {
      const res = await pyClient.send({
        id: 'py-utf8',
        code: `
title = "鹈鹕骑自行车"
f"【{title}】动画计算完成"
`
      });
      assert.equal(res.success, true);
      assert.equal(res.result, '【鹈鹕骑自行车】动画计算完成');
    });

    test('should reset namespace when requested', async () => {
      const resetRes = await pyClient.send({ id: 'py-reset', action: 'reset' });
      assert.equal(resetRes.success, true);

      // Trying to access previously defined 'radius' should fail
      const checkRes = await pyClient.send({ id: 'py-check', code: 'radius' });
      assert.equal(checkRes.success, false);
      assert.ok(checkRes.error.includes("'radius' is not defined"));
    });

    test('should have eager standard math/algorithms modules pre-imported without import', async () => {
      const res = await pyClient.send({
        id: 'py-eager-scope',
        code: `[math.hypot(3, 4), json.loads('{"a": 1}')['a'], collections.Counter(['x', 'x', 'y'])['x']]`
      });
      assert.equal(res.success, true);
      assert.deepEqual(res.result, [5.0, 1, 2]);
    });

    test('should clean binary floating point noise in repr', async () => {
      const res = await pyClient.send({
        id: 'py-float-clean',
        code: '0.1 + 0.2'
      });
      assert.equal(res.success, true);
      assert.equal(res.resultRepr, '0.3');
    });

    test('teardown python worker', () => {
      if (pyClient) pyClient.kill();
    });
  });

  describe('Node.js Worker (node_worker.mjs)', () => {
    let nodeClient;

    test('should start and send ready signal', async () => {
      nodeClient = launchWorker('node', [NODE_WORKER_PATH]);
      const readyMsg = await nodeClient.ready;
      assert.equal(readyMsg.status, 'ready');
      assert.ok(typeof readyMsg.pid === 'number');
    });

    test('should respond to ping action', async () => {
      const res = await nodeClient.send({ id: 'node-ping', action: 'ping' });
      assert.equal(res.id, 'node-ping');
      assert.equal(res.status, 'pong');
      assert.equal(res.success, true);
    });

    test('should evaluate expression and capture return value', async () => {
      const res = await nodeClient.send({ id: 'node-eval-1', code: '21 * 2' });
      assert.equal(res.success, true);
      assert.equal(res.result, 42);
      assert.ok(res.executionTimeMs >= 0);
    });

    test('should capture stdout from console.log', async () => {
      const res = await nodeClient.send({ id: 'node-log', code: 'console.log("Hello from Node Worker!", 123)' });
      assert.equal(res.success, true);
      assert.equal(res.stdout, 'Hello from Node Worker! 123\n');
    });

    test('should support top-level await', async () => {
      const res = await nodeClient.send({
        id: 'node-async',
        code: `
const val = await Promise.resolve(999);
val + 1;
`
      });
      assert.equal(res.success, true);
      assert.equal(res.result, 1000);
    });

    test('should retain global state across turns', async () => {
      // Turn 1: define global state and helper
      const res1 = await nodeClient.send({
        id: 'node-state-1',
        code: `
globalThis.counter = 10;
globalThis.increment = (step = 1) => {
  globalThis.counter += step;
  return globalThis.counter;
};
`
      });
      assert.equal(res1.success, true);

      // Turn 2: invoke helper
      const res2 = await nodeClient.send({
        id: 'node-state-2',
        code: 'globalThis.increment(5)'
      });
      assert.equal(res2.success, true);
      assert.equal(res2.result, 15);

      // Turn 3: check counter directly
      const res3 = await nodeClient.send({
        id: 'node-state-3',
        code: 'globalThis.counter'
      });
      assert.equal(res3.success, true);
      assert.equal(res3.result, 15);
    });

    test('should handle runtime errors without crashing worker', async () => {
      const res = await nodeClient.send({
        id: 'node-err',
        code: 'throw new Error("Deliberate error in worker");'
      });
      assert.equal(res.success, false);
      assert.ok(res.error.includes('Deliberate error in worker'));

      // Verify worker remains alive and state intact
      const aliveRes = await nodeClient.send({
        id: 'node-alive',
        code: 'globalThis.counter + 10'
      });
      assert.equal(aliveRes.success, true);
      assert.equal(aliveRes.result, 25);
    });

    test('should reset context when requested', async () => {
      const resetRes = await nodeClient.send({ id: 'node-reset', action: 'reset' });
      assert.equal(resetRes.success, true);

      // counter should now be undefined in fresh context
      const checkRes = await nodeClient.send({ id: 'node-check', code: 'typeof globalThis.counter' });
      assert.equal(checkRes.success, true);
      assert.equal(checkRes.result, 'undefined');
    });

    test('should clean binary floating point noise in repr', async () => {
      const res = await nodeClient.send({
        id: 'node-float-clean',
        code: '0.1 + 0.2'
      });
      assert.equal(res.success, true);
      assert.equal(res.resultRepr, '0.3');
    });

    test('should preserve top-level declarations when await appears in strings, comments, or async functions', async () => {
      const res1 = await nodeClient.send({
        id: 'node-false-await-1',
        code: `
// await something in comment
const note = "await inside string";
async function helperAsync(v) { return await Promise.resolve(v + 1); }
let retained = 7;
`
      });
      assert.equal(res1.success, true);

      const res2 = await nodeClient.send({
        id: 'node-false-await-2',
        code: 'retained + note.length'
      });
      assert.equal(res2.success, true);
      assert.equal(res2.result, 7 + 'await inside string'.length);

      const res3 = await nodeClient.send({
        id: 'node-false-await-3',
        code: 'await helperAsync(41) // trailing comment should compile'
      });
      assert.equal(res3.success, true);
      assert.equal(res3.result, 42);
    });

    test('teardown node worker', () => {
      if (nodeClient) nodeClient.kill();
    });
  });
});
