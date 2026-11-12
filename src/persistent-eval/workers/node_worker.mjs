#!/usr/bin/env node
/**
 * node_worker.mjs - Zero-dependency persistent Node.js worker for DSH Agent.
 * Maintains a stateful VM context across execution frames over stdio line-delimited JSON.
 */

import readline from 'node:readline';
import vm from 'node:vm';
import util from 'node:util';
import process from 'node:process';

function createFreshContext() {
  const sandbox = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: {
      env: { ...process.env },
      cwd: () => process.cwd(),
      version: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };

  const context = vm.createContext(sandbox);
  context.global = context;
  context.globalThis = context;
  return context;
}

let CURRENT_CONTEXT = createFreshContext();

function serializeResult(val) {
  if (val === undefined) return { result: null, resultRepr: 'undefined' };
  if (val === null) return { result: null, resultRepr: 'null' };

  let repr;
  try {
    repr = util.inspect(val, { depth: 4, maxArrayLength: 100, breakLength: 80 });
  } catch {
    repr = String(val);
  }

  let serializable;
  try {
    serializable = JSON.parse(JSON.stringify(val));
  } catch {
    serializable = repr;
  }

  return { result: serializable, resultRepr: repr };
}

function wrapAsyncCode(code) {
  const trimmed = code.trim();
  if (/\breturn\s+/.test(trimmed)) {
    return `(async () => {\n${trimmed}\n})()`;
  }

  const lines = trimmed.split('\n');
  let lastIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastIndex = i;
      break;
    }
  }

  if (lastIndex === -1) {
    return `(async () => {})()`;
  }

  const lastLine = lines[lastIndex].trim();
  const statementKeywords = /^(const|let|var|function|class|import|export|throw|return|if|else|while|for|switch|case|default|try|catch|finally)\b/;

  if (!statementKeywords.test(lastLine)) {
    const expr = lastLine.endsWith(';') ? lastLine.slice(0, -1) : lastLine;
    lines[lastIndex] = `return (${expr});`;
    return `(async () => {\n${lines.join('\n')}\n})()`;
  }

  return `(async () => {\n${trimmed}\n})()`;
}

async function executeInContext(code, context) {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  // If code appears to use top-level await, wrap in async IIFE
  const hasTopLevelAwait = /\bawait\s+/.test(trimmed);

  if (hasTopLevelAwait) {
    const wrappedCode = wrapAsyncCode(trimmed);
    const script = new vm.Script(wrappedCode, { filename: '<eval_kernel>' });
    const promise = script.runInContext(context, { breakOnSigint: true });
    return await promise;
  } else {
    // Standard execution: natively returns the value of the last evaluated expression
    const script = new vm.Script(trimmed, { filename: '<eval_kernel>' });
    return script.runInContext(context, { breakOnSigint: true });
  }
}

function sendFrame(payload) {
  const line = JSON.stringify(payload) + '\n';
  process.stdout.write(line, 'utf-8');
}

function main() {
  // Send ready frame on startup
  sendFrame({ status: 'ready', pid: process.pid });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      sendFrame({
        id: null,
        success: false,
        error: `Invalid JSON payload: ${e.message}`,
        stdout: '',
        stderr: '',
        executionTimeMs: 0
      });
      return;
    }

    const reqId = req.id;
    const action = req.action || 'eval';
    const code = req.code || '';
    const shouldReset = Boolean(req.reset);

    if (action === 'ping') {
      sendFrame({
        id: reqId,
        success: true,
        status: 'pong',
        pid: process.pid
      });
      return;
    }

    if (action === 'reset' || shouldReset) {
      CURRENT_CONTEXT = createFreshContext();
      if (action === 'reset') {
        sendFrame({
          id: reqId,
          success: true,
          stdout: '',
          stderr: '',
          result: 'Node VM context reset successfully.',
          executionTimeMs: 0
        });
        return;
      }
    }

    let stdoutBuf = '';
    let stderrBuf = '';

    // Intercept console inside context
    const customConsole = {
      log: (...args) => {
        stdoutBuf += util.format(...args) + '\n';
      },
      info: (...args) => {
        stdoutBuf += util.format(...args) + '\n';
      },
      warn: (...args) => {
        stderrBuf += util.format(...args) + '\n';
      },
      error: (...args) => {
        stderrBuf += util.format(...args) + '\n';
      }
    };
    CURRENT_CONTEXT.console = customConsole;

    const startTime = performance.now();
    let success = true;
    let errorMsg = null;
    let rawResult;

    try {
      rawResult = await executeInContext(code, CURRENT_CONTEXT);
    } catch (err) {
      success = false;
      errorMsg = err instanceof Error ? err.stack || err.message : String(err);
      stderrBuf += errorMsg + '\n';
    }

    const elapsedMs = Number((performance.now() - startTime).toFixed(3));
    const { result, resultRepr } = serializeResult(rawResult);

    sendFrame({
      id: reqId,
      success,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      result: success ? result : null,
      resultRepr: success ? resultRepr : null,
      error: success ? null : errorMsg,
      executionTimeMs: elapsedMs
    });
  });
}

main();
