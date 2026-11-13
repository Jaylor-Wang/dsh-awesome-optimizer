import { spawn } from 'node:child_process';
import readline from 'node:readline';
import process from 'node:process';

/**
 * Manages a single stateful worker process with stdio line-delimited JSON RPC,
 * watchdog timeout self-healing, and output anti-dumping guard.
 */
export class StdioWorkerRunner {
  /**
   * @param {object} options
   * @param {string} options.command - e.g. 'python' or 'node'
   * @param {string[]} options.args - CLI arguments
   * @param {number} [options.timeoutMs=15000] - Hard execution timeout before killing
   * @param {number} [options.maxOutputBytes=8192] - Max stdout/stderr allowed before truncation
   * @param {object} [options.env={}] - Additional environment variables
   */
  constructor(options) {
    this.command = options.command;
    this.args = options.args || [];
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxOutputBytes = options.maxOutputBytes ?? 8192;
    this.env = options.env || {};

    this.child = null;
    this.rl = null;
    this.isReady = false;
    this.isDestroyed = false;
    this.currentTask = null;
    this.pendingQueue = [];
    this.readyWaiters = [];
    this.launchCount = 0;
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

  ensureStarted() {
    if (this.isDestroyed) {
      return Promise.reject(new Error('Worker runner has been destroyed.'));
    }
    if (this.child && !this.child.killed && this.isReady) {
      return Promise.resolve();
    }
    if (this.child && !this.child.killed && !this.isReady) {
      return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    }
    return this._spawnProcess();
  }

  _resolveReadyWaiters() {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const w of waiters) w.resolve();
  }

  _rejectReadyWaiters(err) {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const w of waiters) w.reject(err);
  }

  _spawnProcess() {
    this.launchCount++;
    this.isReady = false;

    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });

      try {
        const mergedEnv = {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          ...this.env
        };

        this.child = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: mergedEnv,
          windowsHide: true
        });

        this._ref();

        this.rl = readline.createInterface({
          input: this.child.stdout,
          terminal: false
        });

        this.rl.on('line', line => this._handleStdoutLine(line));

        this.child.stderr.on('data', chunk => {
          // Worker-level unhandled stderr logging (not during task execution)
          if (this.currentTask) {
            this.currentTask.stderrChunk = (this.currentTask.stderrChunk || '') + chunk.toString('utf-8');
          }
        });

        this.child.on('error', err => {
          this._handleProcessFailure(err);
        });

        this.child.on('exit', (code, signal) => {
          this._handleProcessExit(code, signal);
        });
      } catch (err) {
        this.isReady = false;
        this.child = null;
        this.rl = null;
        this._rejectReadyWaiters(err);
      }
    });
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
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);

      this._truncateAndResolve(task, parsed);
      this._drainQueue();
    }
  }

  _truncateAndResolve(task, response) {
    let stdout = response.stdout || '';
    let stderr = (response.stderr || '') + (task.stderrChunk || '');

    const limit = this.maxOutputBytes;
    if (stdout.length > limit) {
      stdout = stdout.slice(0, limit) + `\n\n[Output truncated: stdout exceeded ${limit} bytes. If full payload is required, write it to a file directly.]`;
    }
    if (stderr.length > limit) {
      stderr = stderr.slice(0, limit) + `\n\n[Output truncated: stderr exceeded ${limit} bytes.]`;
    }

    response.stdout = stdout;
    response.stderr = stderr;
    task.resolve(response);
  }

  _handleProcessFailure(err) {
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
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.reject(err);
    }
    this._drainQueue();
  }

  _handleProcessExit(code, signal) {
    const wasReady = this.isReady;
    this.isReady = false;
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this.child = null;

    if (!wasReady && this.readyWaiters.length > 0) {
      this._rejectReadyWaiters(
        new Error(`Worker process exited before ready (code: ${code}, signal: ${signal}).`)
      );
    }

    if (this.currentTask) {
      const task = this.currentTask;
      this.currentTask = null;
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);

      task.resolve({
        id: task.id,
        success: false,
        error: task.killedByWatchdog
          ? `Execution timed out after ${this.timeoutMs}ms. Worker process was terminated and will be restarted cleanly.`
          : `Worker process exited unexpectedly (code: ${code}, signal: ${signal}).`,
        stdout: '',
        stderr: task.stderrChunk || '',
        executionTimeMs: this.timeoutMs
      });
    }

    this._drainQueue();
  }

  async execute(code, options = {}) {
    if (this.isDestroyed) {
      throw new Error('Worker runner has been destroyed.');
    }

    await this.ensureStarted();

    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      id,
      action: options.action || 'eval',
      code: code || '',
      reset: Boolean(options.reset)
    };

    return new Promise((resolve, reject) => {
      this.pendingQueue.push({ id, payload, resolve, reject, options });
      if (!this.currentTask) {
        this._drainQueue();
      }
    });
  }

  async _drainQueue() {
    if (this.currentTask || this.isDestroyed) {
      return;
    }

    if (this.pendingQueue.length === 0) {
      this._unref();
      return;
    }

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
        this._drainQueue();
        return;
      }
    }

    if (this.currentTask || this.pendingQueue.length === 0 || this.isDestroyed || !this.child) {
      if (this.pendingQueue.length === 0) this._unref();
      return;
    }

    const task = this.pendingQueue.shift();
    this.currentTask = task;

    // Armed watchdog timer
    const effectiveTimeout = task.options?.timeoutMs ?? this.timeoutMs;
    task.timeoutTimer = setTimeout(() => {
      task.killedByWatchdog = true;
      this._forceKill();
    }, effectiveTimeout);

    try {
      const line = JSON.stringify(task.payload) + '\n';
      this.child.stdin.write(line, 'utf-8');
    } catch (err) {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      this.currentTask = null;
      task.reject(err);
      this._drainQueue();
    }
  }

  _forceKill() {
    if (!this.child) return;
    const pid = this.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        // Force terminate process tree on Windows to prevent orphan python processes
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGKILL');
      }
    } catch {
      try {
        this.child.kill('SIGKILL');
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
      if (this.currentTask.timeoutTimer) {
        clearTimeout(this.currentTask.timeoutTimer);
      }
      this.currentTask.reject(destroyErr);
      this.currentTask = null;
    }
    this._rejectReadyWaiters(destroyErr);
    const pending = this.pendingQueue.splice(0, this.pendingQueue.length);
    for (const task of pending) {
      task.reject(destroyErr);
    }
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this._forceKill();
    this.child = null;
  }
}
