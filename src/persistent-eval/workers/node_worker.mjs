#!/usr/bin/env node
/**
 * node_worker.mjs - Zero-dependency persistent Node.js worker for DSH Agent.
 * Maintains a stateful VM context across execution frames over stdio line-delimited JSON.
 */

import readline from 'node:readline';
import vm from 'node:vm';
import util from 'node:util';
import process from 'node:process';
import path from 'node:path';

function createFreshContext() {
  const sandbox = {
    CWD: process.cwd(),
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
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      repr = String(val);
      return { result: repr, resultRepr: repr };
    }
    if (!Number.isInteger(val)) {
      const rounded = Number(val.toFixed(10));
      if (Math.abs(val - rounded) < 1e-12) {
        repr = String(rounded);
      } else {
        repr = String(val);
      }
    } else {
      repr = String(val);
    }
  } else {
    try {
      repr = util.inspect(val, { depth: 4, maxArrayLength: 100, breakLength: 80 });
    } catch {
      repr = String(val);
    }
  }

  let serializable;
  try {
    serializable = JSON.parse(JSON.stringify(val));
  } catch {
    serializable = repr;
  }

  return { result: serializable, resultRepr: repr };
}

function formatCaughtError(err) {
  // Errors thrown inside vm.createContext() belong to a different realm, so `err instanceof Error` is false.
  if (util.types.isNativeError(err) || err instanceof Error) {
    return err.stack || err.message || String(err);
  }
  if (err && typeof err === 'object' && typeof err.stack === 'string' && err.stack) {
    return err.stack;
  }
  return String(err);
}

function wrapAsyncCode(code) {
  const trimmed = code.trim();
  const lines = trimmed.split('\n');
  let lastIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineTrimmed = lines[i].trim();
    if (lineTrimmed.length > 0 && !lineTrimmed.startsWith('//') && !/^\/\*.*\*\/$/.test(lineTrimmed)) {
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
    const candidateLines = [...lines];
    candidateLines[lastIndex] = `return (\n${expr}\n);`;
    const candidate = `(async () => {\n${candidateLines.join('\n')}\n})()`;
    try {
      new vm.Script(candidate, { filename: '<eval_kernel>' });
      return candidate;
    } catch {
      // Fall back to executing unmodified statements if wrapping last line fails syntax check
    }
  }

  return `(async () => {\n${trimmed}\n})()`;
}

async function executeInContext(code, context) {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  // Compile synchronously first so await inside strings, comments, or async functions
  // never triggers unnecessary IIFE wrapping that would shadow top-level declarations.
  let syncScript;
  try {
    syncScript = new vm.Script(trimmed, { filename: '<eval_kernel>' });
  } catch (err) {
    if (err instanceof SyntaxError && /\bawait\b/i.test(err.message)) {
      const wrappedCode = wrapAsyncCode(trimmed);
      const asyncScript = new vm.Script(wrappedCode, { filename: '<eval_kernel>' });
      const promise = asyncScript.runInContext(context, { breakOnSigint: true });
      return await promise;
    }
    throw err;
  }

  return syncScript.runInContext(context, { breakOnSigint: true });
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function createBoundedCapture(maxBytes, label) {
  const suffix = `\n\n[Output truncated: ${label} exceeded ${maxBytes} bytes.]`;
  let value = '';
  let truncated = false;
  return {
    write(chunk) {
      if (truncated) return;
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (byteLength(value) + byteLength(text) <= maxBytes) {
        value += text;
        return;
      }
      const effectiveSuffix = byteLength(suffix) >= maxBytes ? '\n[Output truncated]' : suffix;
      const suffixBytes = byteLength(effectiveSuffix);
      const available = Math.max(0, maxBytes - byteLength(value) - suffixBytes);
      const bytes = Buffer.from(text, 'utf8');
      let end = Math.min(available, bytes.length);
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      value += bytes.subarray(0, end).toString('utf8');
      if (byteLength(value) + suffixBytes <= maxBytes) value += effectiveSuffix;
      else value = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
      truncated = true;
    },
    get value() { return value; }
  };
}

function sendFrame(payload) {
  let line;
  try {
    line = JSON.stringify(payload) + '\n';
  } catch (err) {
    line = JSON.stringify({
      id: payload.id,
      success: false,
      error: `Failed to serialize response frame: ${err.message}`,
      stdout: payload.stdout || '',
      stderr: payload.stderr || '',
      executionTimeMs: payload.executionTimeMs || 0
    }) + '\n';
  }
  process.stdout.write(line, 'utf-8');
}

function main() {
  // Send ready frame on startup
  sendFrame({ status: 'ready', pid: process.pid });

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  const handleLine = async rawLine => {
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

    const maxOutputBytes = Number.isInteger(req.maxOutputBytes) && req.maxOutputBytes >= 0
      ? req.maxOutputBytes
      : 8192;
    const stdoutCapture = createBoundedCapture(maxOutputBytes, 'stdout');
    const stderrCapture = createBoundedCapture(maxOutputBytes, 'stderr');

    // Intercept console inside context with byte-bounded UTF-8 buffers.
    const customConsole = {
      log: (...args) => stdoutCapture.write(util.format(...args) + '\n'),
      info: (...args) => stdoutCapture.write(util.format(...args) + '\n'),
      warn: (...args) => stderrCapture.write(util.format(...args) + '\n'),
      error: (...args) => stderrCapture.write(util.format(...args) + '\n')
    };
    CURRENT_CONTEXT.console = customConsole;

    const startTime = performance.now();
    let success = true;
    let errorMsg = null;
    let rawResult;

    try {
      if (Object.hasOwn(req, 'cwd')) {
        if (typeof req.cwd !== 'string' || !path.isAbsolute(req.cwd)) {
          throw new TypeError('cwd must be an absolute directory path');
        }
        process.chdir(req.cwd);
      }
      if (action === 'reset' || shouldReset) {
        CURRENT_CONTEXT = createFreshContext();
        CURRENT_CONTEXT.console = customConsole;
      }
      CURRENT_CONTEXT.CWD = process.cwd();
      rawResult = action === 'reset'
        ? 'Node VM context reset successfully.'
        : await executeInContext(code, CURRENT_CONTEXT);
    } catch (err) {
      success = false;
      errorMsg = formatCaughtError(err);
      stderrCapture.write(errorMsg + '\n');
    }

    const elapsedMs = Number((performance.now() - startTime).toFixed(3));
    const { result, resultRepr } = serializeResult(rawResult);

    sendFrame({
      id: reqId,
      success,
      stdout: stdoutCapture.value,
      stderr: stderrCapture.value,
      result: success ? result : null,
      resultRepr: success ? resultRepr : null,
      error: success ? null : errorMsg,
      executionTimeMs: elapsedMs
    });
  };

  // Serialize incoming requests strictly in arrival order even if multiple frames are pipelined.
  let lineChain = Promise.resolve();
  rl.on('line', rawLine => {
    lineChain = lineChain.then(() => handleLine(rawLine)).catch(() => {});
  });
}

main();
