import { after, before, describe, test } from 'node:test';
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

  const closed = new Promise(resolve => child.once('close', resolve));
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
      return closed;
    },
    getStderr: () => stderrOutput
  };
}

describe('Persistent Eval Workers (Phase 1)', () => {
  describe('Python Worker (py_worker.py)', () => {
    let pyClient;
    before(() => { pyClient = launchWorker('python', ['-u', PY_WORKER_PATH]); });
    after(() => pyClient?.kill());

    test('should start and send ready signal', async () => {
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

    test('should preserve user and library frames while hiding worker frames', async () => {
      const res = await pyClient.send({
        id: 'py-user-trace',
        code: 'def outer():\n    return inner()\ndef inner():\n    return json.loads("{")\nouter()'
      });
      assert.equal(res.success, false);
      assert.match(res.stderr, /File "<eval_kernel>", line 5/);
      assert.match(res.stderr, /File "<eval_kernel>", line 2, in outer/);
      assert.match(res.stderr, /File "<eval_kernel>", line 4, in inner/);
      assert.match(res.stderr, /decoder\.py/);
      assert.match(res.stderr, /JSONDecodeError/);
      assert.doesNotMatch(res.stderr, /py_worker\.py|in execute_code|in main/);
    });

    test('should preserve syntax source and caret without worker frames', async () => {
      const res = await pyClient.send({ id: 'py-syntax-trace', code: 'answer = 1\nif True print(answer)' });
      assert.equal(res.success, false);
      assert.match(res.stderr, /File "<eval_kernel>", line 2/);
      assert.match(res.stderr, /if True print\(answer\)/);
      assert.match(res.stderr, /\^/);
      assert.match(res.stderr, /SyntaxError/);
      assert.doesNotMatch(res.stderr, /py_worker\.py|ast\.py/);
    });

    test('should filter worker frames in explicit and implicit exception chains', async () => {
      for (const suffix of [' from cause', '']) {
        const res = await pyClient.send({
          id: `py-exception-chain-${suffix.length}`,
          code: 'try:\n    1 / 0\nexcept ZeroDivisionError as cause:\n    raise ValueError("outer failure")' + suffix
        });
        assert.equal(res.success, false);
        assert.match(res.stderr, /ZeroDivisionError: division by zero/);
        assert.match(res.stderr, /ValueError: outer failure/);
        assert.match(res.stderr, suffix ? /direct cause/ : /During handling/);
        assert.match(res.stderr, /File "<eval_kernel>", line 2/);
        assert.match(res.stderr, /File "<eval_kernel>", line 4/);
        assert.doesNotMatch(res.stderr, /py_worker\.py/);
      }
    });

    test('should filter worker frames inside exception groups', async () => {
      const res = await pyClient.send({
        id: 'py-exception-group',
        code: 'try:\n    1 / 0\nexcept Exception as cause:\n    raise ExceptionGroup("group failure", [cause, ValueError("second failure")])'
      });
      assert.equal(res.success, false);
      assert.match(res.stderr, /ExceptionGroup: group failure/);
      assert.match(res.stderr, /ZeroDivisionError: division by zero/);
      assert.match(res.stderr, /ValueError: second failure/);
      assert.match(res.stderr, /File "<eval_kernel>", line 2/);
      assert.doesNotMatch(res.stderr, /py_worker\.py/);
    });

    test('should have eager standard math/algorithms modules pre-imported without import', async () => {
      const res = await pyClient.send({
        id: 'py-eager-scope',
        code: `[math.hypot(3, 4), json.loads('{"a": 1}')['a'], collections.Counter(['x', 'x', 'y'])['x']]`
      });
      assert.equal(res.success, true);
      assert.deepEqual(res.result, [5.0, 1, 2]);
    });

    test('should provide file analysis modules after both namespace reset paths', async () => {
      const code = '[pathlib.Path(CWD).is_dir(), list(difflib.unified_diff(["a"], ["b"], lineterm=""))[-2:], list(csv.reader(["key,value"]))]';
      const expected = [true, ['-a', '+b'], [['key', 'value']]];
      const explicit = await pyClient.send({ id: 'py-analysis-explicit-reset', code });
      assert.equal(explicit.success, true);
      assert.deepEqual(explicit.result, expected);
      const inline = await pyClient.send({ id: 'py-analysis-inline-reset', reset: true, code });
      assert.equal(inline.success, true);
      assert.deepEqual(inline.result, expected);
    });

    test('should clean binary floating point noise in repr', async () => {
      const res = await pyClient.send({
        id: 'py-float-clean',
        code: '0.1 + 0.2'
      });
      assert.equal(res.success, true);
      assert.equal(res.resultRepr, '0.3');
    });

    test('should serialize NaN, Infinity, and nested non-finite floats as strict RFC 8259 JSON', async () => {
      for (const [code, expected] of [
        ['float("nan")', 'nan'],
        ['float("inf")', 'inf'],
        ['float("-inf")', '-inf'],
        ['[1, float("nan"), {"x": float("inf")}]', "[1, nan, {'x': inf}]"]
      ]) {
        const res = await pyClient.send({ id: `py-nonfinite-${expected}`, code });
        assert.equal(res.success, true);
        assert.equal(res.result, expected);
        assert.equal(res.resultRepr, expected);
      }
      // Worker remains responsive after non-finite results
      const followUp = await pyClient.send({ id: 'py-nonfinite-followup', code: '2 + 3' });
      assert.equal(followUp.success, true);
      assert.equal(followUp.result, 5);
    });

    test('should bound oversized return values to maxOutputBytes without corrupting UTF-8', async () => {
      for (const [id, code] of [
        ['py-big-str', '"中😀" * 500'],
        ['py-big-list', 'list(range(1000))']
      ]) {
        const res = await pyClient.send({ id, code, maxOutputBytes: 64 });
        assert.equal(res.success, true);
        assert.equal(typeof res.resultRepr, 'string');
        assert.equal(typeof res.result, 'string');
        assert.ok(Buffer.byteLength(res.resultRepr, 'utf8') <= 64);
        assert.ok(Buffer.byteLength(res.result, 'utf8') <= 64);
        assert.doesNotMatch(res.resultRepr, /\uFFFD/);
        assert.match(res.resultRepr, /Output truncated/);
      }
    });
  });

  describe('Node.js Worker (node_worker.mjs)', () => {
    let nodeClient;
    before(() => { nodeClient = launchWorker('node', [NODE_WORKER_PATH]); });
    after(() => nodeClient?.kill());

    test('should start and send ready signal', async () => {
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

    test('should preserve full stack traces for errors thrown across VM realms', async () => {
      const customErr = await nodeClient.send({
        id: 'node-vm-stack-1',
        code: 'function innerBoom() { throw new Error("vm realm boom"); }\nfunction outerBoom() { return innerBoom(); }\nouterBoom();'
      });
      assert.equal(customErr.success, false);
      assert.match(customErr.error, /Error: vm realm boom/);
      assert.match(customErr.error, /at innerBoom \(<eval_kernel>:1:/);
      assert.match(customErr.error, /at outerBoom \(<eval_kernel>:2:/);
      assert.match(customErr.stderr, /at innerBoom \(<eval_kernel>:1:/);

      const typeErr = await nodeClient.send({
        id: 'node-vm-stack-2',
        code: 'const target = null;\ntarget.missingProp;'
      });
      assert.equal(typeErr.success, false);
      assert.match(typeErr.error, /TypeError:/);
      assert.match(typeErr.error, /<eval_kernel>:2:/);
    });

    test('should serialize NaN and Infinity cleanly without collapsing them to null', async () => {
      for (const [code, expected] of [
        ['NaN', 'NaN'],
        ['Infinity', 'Infinity'],
        ['-Infinity', '-Infinity']
      ]) {
        const res = await nodeClient.send({ id: `node-nonfinite-${expected}`, code });
        assert.equal(res.success, true);
        assert.equal(res.result, expected);
        assert.equal(res.resultRepr, expected);
      }
    });

    test('should capture trailing expression in async code even when helper functions contain return, and serialize pipelined requests', async () => {
      const asyncHelper = await nodeClient.send({
        id: 'node-async-return-helper',
        code: 'function double(x) { return x * 2; }\nawait Promise.resolve(double(21))'
      });
      assert.equal(asyncHelper.success, true);
      assert.equal(asyncHelper.result, 42);

      // Pipelined async requests sent back-to-back must run strictly sequentially without racing stdout/console
      const [p1, p2] = await Promise.all([
        nodeClient.send({ id: 'pipe-1', code: 'await new Promise(r => setTimeout(r, 60));\nconsole.log("first");\n1' }),
        nodeClient.send({ id: 'pipe-2', code: 'console.log("second");\n2' })
      ]);
      assert.equal(p1.id, 'pipe-1');
      assert.equal(p1.stdout, 'first\n');
      assert.equal(p1.result, 1);
      assert.equal(p2.id, 'pipe-2');
      assert.equal(p2.stdout, 'second\n');
      assert.equal(p2.result, 2);
    });

    test('should handle null-prototype throws, unprintable objects, and oversized results without hanging', async () => {
      const nullProtoErr = await nodeClient.send({
        id: 'node-null-proto-throw',
        code: 'throw Object.create(null);'
      });
      assert.equal(nullProtoErr.id, 'node-null-proto-throw');
      assert.equal(nullProtoErr.success, false);
      assert.ok(typeof nullProtoErr.error === 'string' && nullProtoErr.error.length > 0);

      const badToStringErr = await nodeClient.send({
        id: 'node-bad-tostring-throw',
        code: 'throw { toString() { throw new Error("bad toString"); } };'
      });
      assert.equal(badToStringErr.id, 'node-bad-tostring-throw');
      assert.equal(badToStringErr.success, false);
      assert.ok(typeof badToStringErr.error === 'string' && badToStringErr.error.length > 0);

      const unprintableRes = await nodeClient.send({
        id: 'node-unprintable-res',
        code: 'Object.assign(Object.create(null), { [Symbol.for("nodejs.util.inspect.custom")]() { throw new Error("inspect boom"); } })'
      });
      assert.equal(unprintableRes.id, 'node-unprintable-res');
      assert.equal(unprintableRes.success, true);
      assert.equal(typeof unprintableRes.resultRepr, 'string');

      const revokedRes = await nodeClient.send({
        id: 'node-revoked-proxy-res',
        code: '(() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })()'
      });
      assert.equal(revokedRes.id, 'node-revoked-proxy-res');
      assert.equal(revokedRes.success, false);
      assert.match(revokedRes.error, /revoked/i);

      for (const [id, code] of [
        ['node-big-str', '"中😀".repeat(500)'],
        ['node-big-arr', 'Array.from({ length: 1000 }, (_, i) => i)']
      ]) {
        const res = await nodeClient.send({ id, code, maxOutputBytes: 64 });
        assert.equal(res.success, true);
        assert.equal(typeof res.resultRepr, 'string');
        assert.equal(typeof res.result, 'string');
        assert.ok(Buffer.byteLength(res.resultRepr, 'utf8') <= 64);
        assert.ok(Buffer.byteLength(res.result, 'utf8') <= 64);
        assert.doesNotMatch(res.resultRepr, /\uFFFD/);
        assert.match(res.resultRepr, /Output truncated/);
      }

      // Tiny maxOutputBytes (< suffix length) must still preserve valid UTF-8 boundaries
      const tinyStdout = await nodeClient.send({
        id: 'node-tiny-utf8-stdout',
        code: 'console.log("中😀".repeat(20))',
        maxOutputBytes: 10
      });
      assert.equal(tinyStdout.success, true);
      assert.ok(Buffer.byteLength(tinyStdout.stdout, 'utf8') <= 10);
      assert.doesNotMatch(tinyStdout.stdout, /\uFFFD/);

      // Worker stays responsive after all edge cases
      const alive = await nodeClient.send({ id: 'node-edge-alive', code: '6 * 7' });
      assert.equal(alive.success, true);
      assert.equal(alive.result, 42);
    });
  });
});
