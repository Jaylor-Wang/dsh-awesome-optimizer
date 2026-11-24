import { spawn } from 'node:child_process';
import readline from 'node:readline';
import process from 'node:process';

const OUTPUT_TRUNCATION_SUFFIX = '\n\n[Output truncated: output exceeded the configured byte limit.]';
const SENSITIVE_ENV_RE = /(?:KEY|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|AUTH)/i;
const HOST_INTERNAL_ENV_RE = /^DSH_/i;

function buildWorkerEnv(baseEnv, overrides = {}, sanitizeEnv = true) {
  const inherited = {};
  for (const [name, value] of Object.entries(baseEnv || {})) {
    if (value === undefined) continue;
    if (sanitizeEnv && (SENSITIVE_ENV_RE.test(name) || HOST_INTERNAL_ENV_RE.test(name))) continue;
    inherited[name] = value;
  }
  return {
    ...inherited,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    ...overrides
  };
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value, maxBytes, suffix = OUTPUT_TRUNCATION_SUFFIX) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  let effectiveSuffix = suffix;
  if (byteLength(effectiveSuffix) >= maxBytes) effectiveSuffix = '\n[Output truncated]';
  const suffixBytes = byteLength(effectiveSuffix);
  const source = Buffer.from(text, 'utf8');
  if (suffixBytes >= maxBytes) {
    let end = Math.min(maxBytes, source.length);
    while (end > 0 && (source[end] & 0xc0) === 0x80) end--;
    return source.subarray(0, end).toString('utf8');
  }
  const contentBytes = maxBytes - suffixBytes;
  let end = Math.min(contentBytes, source.length);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end--;
  return source.subarray(0, end).toString('utf8') + effectiveSuffix;
}

function appendUtf8Bounded(current, chunk, maxBytes) {
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
  const remaining = Math.max(0, maxBytes - byteLength(current));
  if (!remaining) return current;
  return current + truncateUtf8(text, remaining, '');
}
/**
 * Convert an aborted signal's reason into an Error suitable for rejection
 * and DSH cancellation classification.
 */
function toAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason ? reason : 'The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Manages a single stateful worker process with stdio line-delimited JSON RPC,
 * watchdog timeout self-healing, cancellation propagation, and output anti-dumping guard.
 */
export class StdioWorkerRunner {
  /**
   * @param {object} options
   * @param {string} options.command - e.g. 'python' or 'node'
   * @param {string[]} options.args - CLI arguments
   * @param {number} [options.timeoutMs=15000] - Deadline for each startup and execution phase
   * @param {number} [options.maxOutputBytes=8192] - Max stdout/stderr allowed before truncation
   * @param {object} [options.env={}] - Additional environment variables
   */
  constructor(options) {
    this.command = options.command;
    this.args = options.args || [];
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxOutputBytes = options.maxOutputBytes ?? 8192;
    this.env = options.env || {};
    this.sanitizeEnv = options.sanitizeEnv !== false;

    this.child = null;
    this.rl = null;
    this.isReady = false;
    this.isDestroyed = false;
    this.currentTask = null;
    this.pendingQueue = [];
    this.readyWaiters = [];
    this.startupTimer = null;
    this.launchCount = 0;
    this._draining = false;
  }

  _ref() {
    try {
      if (this.child?.ref) this.child.ref();
      if (this.child?.stdin?.ref) this.child.stdin.ref();
      if (this.child?.stdout?.ref) this.child.stdout.ref();
      if (this.child?.stderr?.ref) this.child.stderr.ref();
    } catch {}
  }

  _unref() {
    try {
      if (this.child?.unref) this.child.unref();
      if (this.child?.stdin?.unref) this.child.stdin.unref();
      if (this.child?.stdout?.unref) this.child.stdout.unref();
      if (this.child?.stderr?.unref) this.child.stderr.unref();
    } catch {}
  }

  ensureStarted(signal) {
    if (this.isDestroyed) {
      return Promise.reject(new Error('Worker runner has been destroyed.'));
    }
    if (signal?.aborted) return Promise.reject(toAbortError(signal));
    if (this.child && !this.child.killed && this.isReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index !== -1) this.readyWaiters.splice(index, 1);
        const error = toAbortError(signal);
        waiter.reject(error);
        if (this.child && !this.isReady && this.readyWaiters.length === 0) {
          this._forceKill();
          this._handleProcessFailure(error);
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const waiter = {
        resolve() { cleanup(); resolve(); },
        reject(error) { cleanup(); reject(error); }
      };
      this.readyWaiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      // All callers share the same startup deadline and child.
      if (!this.child) this._spawnProcess();
    });
  }

  _resolveReadyWaiters() {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  _rejectReadyWaiters(err) {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }

  _spawnProcess() {
    this.launchCount++;
    this.isReady = false;

    try {
      const mergedEnv = buildWorkerEnv(process.env, this.env, this.sanitizeEnv);

      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
        windowsHide: true
      });
      this.child = child;
      child.on('error', err => {
        if (this.child !== child) return;
        this._handleProcessFailure(err);
      });
      child.stdin.on('error', err => {
        if (this.child !== child) return;
        if (this.isDestroyed || this.currentTask?.killedByWatchdog) return;
        if (err?.code === 'EPIPE' || err?.code === 'EOF' || err?.code === 'ERR_STREAM_DESTROYED') {
          if (child.exitCode === null && child.signalCode === null && !child.killed) {
            this._forceKill(child);
          }
          return;
        }
        this._handleProcessFailure(err);
      });
      child.on('exit', (code, signal) => {
        if (this.child !== child) return;
        this._handleProcessExit(code, signal);
      });
      this.startupTimer = setTimeout(() => {
        if (this.child !== child || this.isReady) return;
        this._forceKill(child);
        this._handleProcessFailure(new Error(`Worker startup timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this._ref();

      const rl = readline.createInterface({
        input: child.stdout,
        terminal: false
      });
      this.rl = rl;

      rl.on('line', line => {
        if (this.child !== child) return;
        this._handleStdoutLine(line);
      });

      child.stderr.on('data', chunk => {
        if (this.child !== child) return;
        // Worker-level unhandled stderr logging (not during task execution)
        if (this.currentTask) {
          const before = this.currentTask.stderrChunk || '';
          this.currentTask.stderrChunk = appendUtf8Bounded(before, chunk, this.maxOutputBytes);
          if (byteLength(String(chunk)) > Math.max(0, this.maxOutputBytes - byteLength(before))) {
            this.currentTask.stderrTruncated = true;
          }
        }
      });
    } catch (err) {
      this._forceKill();
      this._handleProcessFailure(err);
    }
  }

  _handleStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (parsed.status === 'ready' && !this.isReady) {
      this.isReady = true;
      this._resolveReadyWaiters();
      if (!this.currentTask && this.pendingQueue.length === 0) {
        this._unref();
      }
      return;
    }

    if (this.currentTask && parsed.id === this.currentTask.id) {
      const task = this.currentTask;
      this.currentTask = null;
      this._cleanupTask(task);

      this._truncateAndResolve(task, parsed);
      this._drainQueue();
    }
  }

  _cleanupTask(task) {
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = null;
    }
    if (task.watchdogKillTimer) {
      clearTimeout(task.watchdogKillTimer);
      task.watchdogKillTimer = null;
    }
    if (task.abortCleanup) {
      task.abortCleanup();
      task.abortCleanup = null;
    }
  }

  _truncateAndResolve(task, response) {
    const limit = this.maxOutputBytes;
    response.stdout = truncateUtf8(response.stdout || '', limit,
      `\n\n[Output truncated: stdout exceeded ${limit} bytes. If full payload is required, write it to a file directly.]`);
    const stderrText = `${response.stderr || ''}${task.stderrChunk || ''}`;
    const stderrSuffix = `\n\n[Output truncated: stderr exceeded ${limit} bytes.]`;
    response.stderr = task.stderrTruncated
      ? truncateUtf8(`${stderrText}${stderrSuffix}`, limit, stderrSuffix)
      : truncateUtf8(stderrText, limit, stderrSuffix);
    const resultSuffix = `\n\n[Output truncated: result exceeded ${limit} bytes.]`;
    if (typeof response.resultRepr === 'string' && byteLength(response.resultRepr) > limit) {
      response.resultRepr = truncateUtf8(response.resultRepr, limit, resultSuffix);
    }
    if (typeof response.result === 'string' && byteLength(response.result) > limit) {
      response.result = truncateUtf8(response.result, limit, resultSuffix);
    } else if (response.result !== null && response.result !== undefined && typeof response.result === 'object') {
      try {
        const encoded = JSON.stringify(response.result);
        if (encoded !== undefined && byteLength(encoded) > limit) {
          const fallback = typeof response.resultRepr === 'string' && response.resultRepr
            ? truncateUtf8(response.resultRepr, limit, resultSuffix)
            : truncateUtf8(encoded, limit, resultSuffix);
          response.result = fallback;
          response.resultRepr = fallback;
        }
      } catch {
        const fallback = truncateUtf8(String(response.result), limit, resultSuffix);
        response.result = fallback;
        response.resultRepr = fallback;
      }
    }
    task.resolve(response);
  }

  _handleProcessFailure(err) {
    const wasReady = this.isReady;
    this.isReady = false;
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this.child = null;
    this._rejectReadyWaiters(err);
    if (this.currentTask) {
      const task = this.currentTask;
      this.currentTask = null;
      this._cleanupTask(task);
      task.reject(err);
    }
    // A drain waiting for startup handles its own rejection and retry.
    if (wasReady) this._drainQueue();
  }

  _handleProcessExit(code, signal) {
    const wasReady = this.isReady;
    this.isReady = false;
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this.child = null;

    if (!wasReady || this.readyWaiters.length > 0) {
      this._rejectReadyWaiters(
        new Error(`Worker process exited while waiting for readiness (code: ${code}, signal: ${signal}).`)
      );
    }

    if (this.currentTask) {
      const task = this.currentTask;
      this.currentTask = null;
      this._cleanupTask(task);
      const effectiveTimeout = task.effectiveTimeout ?? this.timeoutMs;
      const elapsedMs = task.startedAt !== undefined
        ? Math.round(Math.max(0, performance.now() - task.startedAt) * 1000) / 1000
        : effectiveTimeout;

      task.resolve({
        id: task.id,
        success: false,
        error: task.killedByWatchdog
          ? `Execution timed out after ${effectiveTimeout}ms. Worker process was terminated and will be restarted cleanly.`
          : `Worker process exited unexpectedly (code: ${code}, signal: ${signal}).`,
        stdout: '',
        stderr: task.stderrChunk || '',
        executionTimeMs: elapsedMs
      });
    }

    if (wasReady) this._drainQueue();
  }

  _abortTask(task, signal) {
    if (task.settled) return;
    const abortErr = toAbortError(signal);
    this._cleanupTask(task);

    if (this.currentTask === task) {
      this.currentTask = null;
      // Detach and terminate the active child process immediately so subsequent tasks get a clean worker
      const dyingChild = this.child;
      this.isReady = false;
      this.child = null;
      if (this.rl) {
        try { this.rl.close(); } catch {}
        this.rl = null;
      }
      this._forceKill(dyingChild);
      task.reject(abortErr);
      this._drainQueue();
      return;
    }

    const queueIdx = this.pendingQueue.indexOf(task);
    if (queueIdx >= 0) {
      this.pendingQueue.splice(queueIdx, 1);
      task.reject(abortErr);
      if (!this.currentTask && this.pendingQueue.length === 0) {
        this._unref();
      }
    }
  }

  async execute(code, options = {}) {
    if (this.isDestroyed) {
      throw new Error('Worker runner has been destroyed.');
    }
    const signal = options.signal;
    if (signal?.aborted) {
      throw toAbortError(signal);
    }

    await this.ensureStarted(signal);
    if (this.isDestroyed) {
      throw new Error('Worker runner has been destroyed.');
    }
    if (signal?.aborted) {
      throw toAbortError(signal);
    }

    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      id,
      action: options.action || 'eval',
      cwd: options.cwd,
      code: code || '',
      reset: Boolean(options.reset),
      maxOutputBytes: this.maxOutputBytes
    };

    return new Promise((resolve, reject) => {
      const task = {
        id,
        payload,
        resolve: val => {
          if (task.settled) return;
          task.settled = true;
          this._cleanupTask(task);
          resolve(val);
        },
        reject: err => {
          if (task.settled) return;
          task.settled = true;
          this._cleanupTask(task);
          reject(err);
        },
        options,
        settled: false,
        timeoutTimer: null,
        abortCleanup: null
      };

      if (signal) {
        const onAbort = () => this._abortTask(task, signal);
        signal.addEventListener('abort', onAbort, { once: true });
        task.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }

      this.pendingQueue.push(task);
      if (!this.currentTask) {
        this._drainQueue();
      }
    });
  }

  async _drainQueue() {
    if (this._draining || this.currentTask || this.isDestroyed) {
      return;
    }

    if (this.pendingQueue.length === 0) {
      this._unref();
      return;
    }

    this._draining = true;
    try {
      this._ref();

      // Ensure child process is healthy and ready before pulling tasks from queue
      if (!this.child || !this.isReady) {
        try {
          await this.ensureStarted();
        } catch (err) {
          const task = this.pendingQueue.shift();
          if (task) {
            task.reject(err);
          }
          return;
        }
      }

      if (this.currentTask || this.pendingQueue.length === 0 || this.isDestroyed || !this.child) {
        if (this.pendingQueue.length === 0) this._unref();
        return;
      }

      const task = this.pendingQueue.shift();
      if (task.options?.signal?.aborted) {
        task.reject(toAbortError(task.options.signal));
        return;
      }
      this.currentTask = task;

      // Armed watchdog timer
      const effectiveTimeout = task.options?.timeoutMs ?? this.timeoutMs;
      task.effectiveTimeout = effectiveTimeout;
      task.startedAt = performance.now();
      task.timeoutTimer = setTimeout(() => {
        task.killedByWatchdog = true;
        const dyingChild = this.child;
        this._forceKill(dyingChild);
        // Fallback in case the OS never emits exit after forced kill.
        task.watchdogKillTimer = setTimeout(() => {
          if (this.currentTask !== task) return;
          this.currentTask = null;
          this.isReady = false;
          if (this.child === dyingChild) this.child = null;
          if (this.rl) {
            try { this.rl.close(); } catch {}
            this.rl = null;
          }
          this._cleanupTask(task);
          task.resolve({
            id: task.id,
            success: false,
            error: `Execution timed out after ${effectiveTimeout}ms. Worker process was terminated and will be restarted cleanly.`,
            stdout: '',
            stderr: task.stderrChunk || '',
            executionTimeMs: Math.round(Math.max(0, performance.now() - task.startedAt) * 1000) / 1000
          });
          this._drainQueue();
        }, 500);
        task.watchdogKillTimer.unref?.();
      }, effectiveTimeout);

      try {
        const line = JSON.stringify(task.payload) + '\n';
        this.child.stdin.write(line, 'utf-8');
      } catch (err) {
        this.currentTask = null;
        this._cleanupTask(task);
        task.reject(err);
      }
    } finally {
      this._draining = false;
      if (!this.currentTask && this.pendingQueue.length > 0 && !this.isDestroyed) {
        void this._drainQueue();
      }
    }
  }

  _forceKill(targetChild = this.child) {
    if (!targetChild) return;
    const pid = targetChild.pid;
    try {
      if (process.platform === 'win32' && pid) {
        // Force terminate process tree on Windows to prevent orphan python processes
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore'
        });
        const fallback = () => {
          if (targetChild.exitCode === null && targetChild.signalCode === null) {
            try { targetChild.kill('SIGKILL'); } catch {}
          }
        };
        killer.on('error', fallback);
        killer.on('exit', code => { if (code !== 0) fallback(); });
      } else {
        targetChild.kill('SIGKILL');
      }
    } catch {
      try {
        targetChild.kill('SIGKILL');
      } catch {
        // Ignored
      }
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.isReady = false;
    const destroyErr = new Error('Worker runner has been destroyed.');
    if (this.currentTask) {
      const task = this.currentTask;
      this.currentTask = null;
      this._cleanupTask(task);
      task.reject(destroyErr);
    }
    this._rejectReadyWaiters(destroyErr);
    const pending = this.pendingQueue.splice(0, this.pendingQueue.length);
    for (const task of pending) {
      this._cleanupTask(task);
      task.reject(destroyErr);
    }
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    const activeChild = this.child;
    this.child = null;
    this._forceKill(activeChild);
  }
}
