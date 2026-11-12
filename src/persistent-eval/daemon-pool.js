import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  }

  _getKey(session) {
    if (!session) return '__global__';
    return session.id || session;
  }

  getPythonRunner(session) {
    const key = this._getKey(session);
    let sessionMap = this.runnersBySession.get(key);
    if (!sessionMap) {
      sessionMap = {};
      this.runnersBySession.set(key, sessionMap);
    }

    if (!sessionMap.python || sessionMap.python.isDestroyed) {
      sessionMap.python = new StdioWorkerRunner({
        command: 'python',
        args: ['-u', PY_WORKER_SCRIPT],
        timeoutMs: this.config.timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes
      });
    }

    return sessionMap.python;
  }

  getNodeRunner(session) {
    const key = this._getKey(session);
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

  destroySession(session) {
    const key = this._getKey(session);
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
    for (const [key, sessionMap] of this.runnersBySession.entries()) {
      if (sessionMap.python) sessionMap.python.destroy();
      if (sessionMap.node) sessionMap.node.destroy();
    }
    this.runnersBySession.clear();
  }
}
