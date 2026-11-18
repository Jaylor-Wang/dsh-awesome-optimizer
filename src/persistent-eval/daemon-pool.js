import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPythonEnv } from '../custom-prompt.js';
import { StdioWorkerRunner } from './stdio-runner.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PY_WORKER_SCRIPT = path.resolve(__dirname, 'workers/py_worker.py');
export const NODE_WORKER_SCRIPT = path.resolve(__dirname, 'workers/node_worker.mjs');

/**
 * Session-scoped daemon pool managing persistent Python and Node worker runners.
 */
export class DaemonPool {
  /**
   * @param {object} config
   * @param {number} [config.timeoutMs=15000]
   * @param {number} [config.maxOutputBytes=8192]
   */
  constructor(config = {}) {
    this.config = config;
    this.runnersBySession = new Map();
    this.disposedKeys = new Set();
    this.isDestroyed = false;
  }

  _getKey(session) {
    if (!session) return '__global__';
    return session.id || session;
  }

  _assertSessionActive(key) {
    if (this.isDestroyed) throw new Error('Daemon pool has been destroyed.');
    if (this.disposedKeys.has(key)) throw new Error('Session workers have been destroyed.');
  }

  reviveSession(session) {
    if (this.isDestroyed) return false;
    this.disposedKeys.delete(this._getKey(session));
    return true;
  }

  getPythonRunner(session) {
    const key = this._getKey(session);
    this._assertSessionActive(key);
    let sessionMap = this.runnersBySession.get(key);
    if (!sessionMap) {
      sessionMap = {};
      this.runnersBySession.set(key, sessionMap);
    }

    if (!sessionMap.python || sessionMap.python.isDestroyed) {
      const pythonBin = this.config.pythonCommand || detectPythonEnv()?.bin || 'python';
      sessionMap.python = new StdioWorkerRunner({
        command: pythonBin,
        args: ['-u', PY_WORKER_SCRIPT],
        timeoutMs: this.config.timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes
      });
    }

    return sessionMap.python;
  }

  getNodeRunner(session) {
    const key = this._getKey(session);
    this._assertSessionActive(key);
    let sessionMap = this.runnersBySession.get(key);
    if (!sessionMap) {
      sessionMap = {};
      this.runnersBySession.set(key, sessionMap);
    }

    if (!sessionMap.node || sessionMap.node.isDestroyed) {
      sessionMap.node = new StdioWorkerRunner({
        command: 'node',
        args: [NODE_WORKER_SCRIPT],
        timeoutMs: this.config.timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes
      });
    }

    return sessionMap.node;
  }

  /**
   * Pre-warm worker processes in background so they are ready before tool execution.
   * Silently swallows startup failures (e.g. missing runtime) so it never interrupts session flow.
   * @param {any} [session]
   * @param {object} [options]
   * @param {boolean} [options.python=true]
   * @param {boolean} [options.node=true]
   */
  async prewarm(session, { python = true, node = true } = {}) {
    const key = this._getKey(session);
    if (this.isDestroyed || this.disposedKeys.has(key)) return;
    const promises = [];
    if (python) {
      try {
        const py = this.getPythonRunner(session);
        promises.push(py.ensureStarted().catch(() => {}));
      } catch {
        // Ignore prewarm failure
      }
    }
    if (node) {
      try {
        const nd = this.getNodeRunner(session);
        promises.push(nd.ensureStarted().catch(() => {}));
      } catch {
        // Ignore prewarm failure
      }
    }
    await Promise.all(promises);
  }

  destroySession(session) {
    const key = this._getKey(session);
    this.disposedKeys.add(key);
    const sessionMap = this.runnersBySession.get(key);
    if (!sessionMap) return;

    if (sessionMap.python) {
      sessionMap.python.destroy();
    }
    if (sessionMap.node) {
      sessionMap.node.destroy();
    }
    this.runnersBySession.delete(key);
  }

  destroyAll() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    for (const [key, sessionMap] of this.runnersBySession.entries()) {
      if (sessionMap.python) sessionMap.python.destroy();
      if (sessionMap.node) sessionMap.node.destroy();
      this.disposedKeys.add(key);
    }
    this.runnersBySession.clear();
  }
}
