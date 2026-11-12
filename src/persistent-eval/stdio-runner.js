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

  ensureStarted() {
    if (this.child && !this.child.killed && this.isReady) {
      return Promise.resolve();
    }
    if (this.child && !this.child.killed && !this.isReady) {
      return new Promise(resolve => this.readyWaiters.push(resolve));
    }
    return this._spawnProcess();
  }

  _spawnProcess() {
    this.launchCount++;
    this.isReady = false;

    return new Promise((resolve, reject) => {
      this.readyWaiters.push(resolve);

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
        reject(err);
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
      const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
      for (const w of waiters) w();
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
    if (this.currentTask) {
      const task = this.currentTask;
      this.currentTask = null;
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.reject(err);
    }
    this._drainQueue();
  }

  _handleProcessExit(code, signal) {
    this.isReady = false;
    this.child = null;
    this.rl = null;

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

  _drainQueue() {
    if (this.currentTask || this.pendingQueue.length === 0 || this.isDestroyed) {
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
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Ignored
      }
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.currentTask && this.currentTask.timeoutTimer) {
      clearTimeout(this.currentTask.timeoutTimer);
    }
    this._forceKill();
    this.child = null;
    this.rl = null;
    this.pendingQueue = [];
    this.currentTask = null;
  }
}
