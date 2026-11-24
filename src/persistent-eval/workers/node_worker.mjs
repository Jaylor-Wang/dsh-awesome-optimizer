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

function safeString(val) {
  try {
    return String(val);
  } catch {
    try {
      return Object.prototype.toString.call(val);
    } catch {
      return '[Unprintable value]';
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function sliceUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function truncateUtf8(value, maxBytes, label) {
  const text = safeString(value ?? '');
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  let suffix = `\n\n[Output truncated: ${label} exceeded ${maxBytes} bytes.]`;
  if (byteLength(suffix) >= maxBytes) suffix = '\n[Output truncated]';
  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= maxBytes) return sliceUtf8(text, maxBytes);
  return sliceUtf8(text, maxBytes - suffixBytes) + suffix;
}

function serializeResult(val, maxOutputBytes = 8192) {
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
  } else if (typeof val === 'string' && byteLength(val) > maxOutputBytes) {
    const truncated = truncateUtf8(val, maxOutputBytes, 'result');
    return { result: truncated, resultRepr: truncated };
  } else {
    try {
      repr = util.inspect(val, {
        depth: 4,
        maxArrayLength: 100,
        maxStringLength: Math.max(256, maxOutputBytes),
        breakLength: 80
      });
    } catch {
      repr = safeString(val);
    }
  }

  const reprExceeded = byteLength(repr) > maxOutputBytes;
  const boundedRepr = reprExceeded ? truncateUtf8(repr, maxOutputBytes, 'result') : repr;

  if (reprExceeded) {
    return { result: boundedRepr, resultRepr: boundedRepr };
  }

  let serializable;
  try {
    const encoded = JSON.stringify(val);
    if (encoded === undefined) {
      serializable = boundedRepr;
    } else if (byteLength(encoded) > maxOutputBytes) {
      const truncated = truncateUtf8(encoded, maxOutputBytes, 'result');
      return { result: truncated, resultRepr: truncated };
    } else {
      serializable = JSON.parse(encoded);
    }
  } catch {
    serializable = boundedRepr;
  }

  return { result: serializable, resultRepr: boundedRepr };
}

function formatCaughtError(err) {
  // Errors thrown inside vm.createContext() belong to a different realm, so `err instanceof Error` is false.
  try {
    if (util.types.isNativeError(err) || err instanceof Error) {
      return err.stack || err.message || safeString(err);
    }
    if (err && typeof err === 'object' && typeof err.stack === 'string' && err.stack) {
      return err.stack;
    }
  } catch {
    // Fall through to safe conversion below.
  }
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    return safeString(err);
  }
  try {
    return String(err);
  } catch {
    try {
      return util.inspect(err, { depth: 4, maxArrayLength: 100, breakLength: 80 });
    } catch {
      return safeString(err);
    }
  }
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

function createBoundedCapture(maxBytes, label) {
  const suffix = `\n\n[Output truncated: ${label} exceeded ${maxBytes} bytes.]`;
  let value = '';
  let truncated = false;
  return {
    write(chunk) {
      if (truncated) return;
      const text = safeString(chunk ?? '');
      if (byteLength(value) + byteLength(text) <= maxBytes) {
        value += text;
        return;
      }
      const effectiveSuffix = byteLength(suffix) >= maxBytes ? '\n[Output truncated]' : suffix;
      const suffixBytes = byteLength(effectiveSuffix);
      const available = Math.max(0, maxBytes - byteLength(value) - suffixBytes);
      value += sliceUtf8(text, available);
      if (byteLength(value) + suffixBytes <= maxBytes) value += effectiveSuffix;
      else value = sliceUtf8(value, maxBytes);
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
    let result = null;
    let resultRepr = null;

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
      const rawResult = action === 'reset'
        ? 'Node VM context reset successfully.'
        : await executeInContext(code, CURRENT_CONTEXT);
      ({ result, resultRepr } = serializeResult(rawResult, maxOutputBytes));
    } catch (err) {
      success = false;
      errorMsg = formatCaughtError(err);
      stderrCapture.write(errorMsg + '\n');
    }

    const elapsedMs = Number((performance.now() - startTime).toFixed(3));

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
    lineChain = lineChain.then(() => handleLine(rawLine)).catch(err => {
      let reqId = null;
      try { reqId = JSON.parse(rawLine.trim())?.id ?? null; } catch {}
      sendFrame({
        id: reqId,
        success: false,
        stdout: '',
        stderr: '',
        result: null,
        resultRepr: null,
        error: formatCaughtError(err),
        executionTimeMs: 0
      });
    });
  });
}

main();
