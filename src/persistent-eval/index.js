import z from '@deepseek-ai/schemastery';
import { DaemonPool } from './daemon-pool.js';

export { DaemonPool, PY_WORKER_SCRIPT, NODE_WORKER_SCRIPT } from './daemon-pool.js';
export { StdioWorkerRunner } from './stdio-runner.js';
export const EVAL_PYTHON_TOOL = 'eval_python';
export const EVAL_NODE_TOOL = 'eval_node';

export const PersistentEvalConfig = z.object({
  enabled: z.boolean().default(true),
  python: z.boolean().default(true),
  node: z.boolean().default(true),
  pythonCommand: z.string(),
  timeoutMs: z.number().step(1).min(50).max(120000).default(15000),
  maxOutputBytes: z.number().step(1).min(64).max(65536).default(8192),
  sanitizeEnv: z.boolean().default(true),
  requireShellTool: z.boolean().default(true)
});

/**
 * Render friendly and compact text representation of execution output for agent response.
 */
export function formatEvalOutput(resp) {
  if (!resp) return 'No response returned from kernel.';

  const parts = [];

  if (resp.stdout && resp.stdout.length > 0) {
    const trimmed = resp.stdout.trimEnd();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }

  if (resp.result !== null && resp.result !== undefined) {
    let repr = resp.resultRepr;
    if (!repr) {
      try {
        repr = typeof resp.result === 'object' ? JSON.stringify(resp.result) : String(resp.result);
      } catch {
        repr = String(resp.result);
      }
    }
    if (typeof resp.result === 'number' && !Number.isInteger(resp.result)) {
      const rounded = Number(resp.result.toFixed(10));
      if (Math.abs(resp.result - rounded) < 1e-12) {
        repr = String(rounded);
      }
    }
    parts.push(`=> ${repr}`);
  }

  if (!resp.success) {
    if (resp.error) parts.push(`[Error: ${resp.error}]`);
    if (resp.stderr && resp.stderr.length > 0) {
      const trimmedErr = resp.stderr.trimEnd();
      if (trimmedErr.length > 0) {
        parts.push(trimmedErr);
      }
    }
  }

  if (parts.length === 0) {
    return resp.success ? '<Executed successfully with no output>' : '<Execution failed with no output>';
  }

  return parts.join('\n');
}

/**
 * Mount stateful persistent Python and Node evaluation tools around the DSH agent loop.
 */
export function applyPersistentEval(ctx, rawConfig = {}) {
  const config = PersistentEvalConfig(rawConfig);
  if (!config.enabled) return null;

  const pool = new DaemonPool({
    pythonCommand: config.pythonCommand,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    sanitizeEnv: config.sanitizeEnv
  });

  const workingDirectories = new Map();
  let objectWorkingDirectories = new WeakMap();
  let disposed = false;
  const sessionKey = session => session?.id || session || '__global__';
  const isObjectKey = key => key !== null && (typeof key === 'object' || typeof key === 'function');
  const getCachedCwd = key => (isObjectKey(key) ? objectWorkingDirectories.get(key) : workingDirectories.get(key));
  const hasCachedCwd = key => (isObjectKey(key) ? objectWorkingDirectories.has(key) : workingDirectories.has(key));
  const setCachedCwd = (key, cwd) => {
    if (isObjectKey(key)) objectWorkingDirectories.set(key, cwd);
    else workingDirectories.set(key, cwd);
  };
  const deleteCachedCwd = key => {
    if (isObjectKey(key)) objectWorkingDirectories.delete(key);
    else workingDirectories.delete(key);
  };
  function getWorkingDirectory(session) {
    const key = sessionKey(session);
    if (!hasCachedCwd(key)) {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory;
        const cwd = service?.get?.(session);
        if (cwd !== undefined) setCachedCwd(key, cwd);
      } catch {
        return undefined;
      }
    }
    return getCachedCwd(key);
  }
  function destroySession(session) {
    deleteCachedCwd(sessionKey(session));
    pool.destroySession(session);
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    workingDirectories.clear();
    objectWorkingDirectories = new WeakMap();
    pool.destroyAll();
  }
  function canPrewarm() {
    if (!config.requireShellTool) return true;
    // On real DSH ToolsService hosts, skip spawning idle workers when bash is not registered globally.
    if (typeof ctx.tools?.executable === 'function' && ctx.tools.get('bash') === undefined) return false;
    return true;
  }
  function prewarmSession(session) {
    if (disposed || !canPrewarm()) return;
    void pool.prewarm(session, { python: config.python, node: config.node });
  }

  // Clean up session workers when sessions end. The official session/event stream
  // is the single lifecycle source; avoid duplicate turn/start prewarm listeners.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'session/destroy' || event?.type === 'session/close' || event?.type === 'session/disposed') {
      destroySession(session);
    } else if (event?.type === 'session/create' || event?.type === 'session/start') {
      pool.reviveSession(session);
      prewarmSession(session);
    } else if (event?.type === 'working-directory/change') {
      setCachedCwd(sessionKey(session), event.data.cwd);
    } else if (event?.type === 'turn/start') {
      prewarmSession(session);
    }
  });

  ctx.on('session/disposed', destroySession);
  // Clean up all daemon workers when plugin context is disposed
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => destroy);
  }

  const registrationOptions = config.requireShellTool
    ? { when: ({ agent }) => ctx.tools.get('bash', agent) !== undefined }
    : undefined;

  if (config.python) {
    ctx.tools.register({
      name: EVAL_PYTHON_TOOL,
      description: [
        'Execute Python code inside a persistent stateful kernel.',
        'Variables, functions, imports, and state persist across calls within the session.',
        'Standard modules (math, re, json, time, collections, itertools, pathlib, difflib, csv) are eagerly pre-imported in scope.',
        'The session working directory is synchronized before execution and exposed as CWD.',
        'Trusted local execution only: this worker inherits the host environment and OS permissions, not the DSH filesystem or shell sandbox.',
        'Use for exploratory calculations and data processing; return compact summaries without writing temp files to disk.'
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: {
            type: 'string',
            description: 'Python code to execute or expression to evaluate.'
          },
          reset: {
            type: 'boolean',
            description: 'Reset kernel state before execution. Defaults to false.'
          }
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (disposed) throw new Error('Persistent eval service has been disposed.');
        exec?.signal?.throwIfAborted();
        const session = exec?.agent?.session ?? exec?.session;
        const runner = pool.getPythonRunner(session);
        const code = args?.code || '';
        const reset = Boolean(args?.reset);

        const response = await runner.execute(code, {
          cwd: getWorkingDirectory(session),
          reset,
          timeoutMs: config.timeoutMs,
          signal: exec?.signal
        });
        return formatEvalOutput(response);
      }
    }, registrationOptions);
  }

  if (config.node) {
    ctx.tools.register({
      name: EVAL_NODE_TOOL,
      description: [
        'Execute JavaScript code inside a persistent stateful Node.js VM context.',
        'Trusted local execution only: the VM is not a security sandbox, and its worker inherits the host environment and OS permissions, not the DSH sandbox.',
        'Top-level declarations persist across synchronous calls; when using top-level await, assign shared state to globalThis (e.g. globalThis.x = await ...) to persist across turns.',
        'The session working directory is synchronized before execution and exposed as CWD.',
        'Use for rapid expression evaluation, AST exploration, and data transformations without writing temp files to disk.'
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Can be expressions, statements, or async code.'
          },
          reset: {
            type: 'boolean',
            description: 'Reset VM context before execution. Defaults to false.'
          }
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (disposed) throw new Error('Persistent eval service has been disposed.');
        exec?.signal?.throwIfAborted();
        const session = exec?.agent?.session ?? exec?.session;
        const runner = pool.getNodeRunner(session);
        const code = args?.code || '';
        const reset = Boolean(args?.reset);

        const response = await runner.execute(code, {
          cwd: getWorkingDirectory(session),
          reset,
          timeoutMs: config.timeoutMs,
          signal: exec?.signal
        });
        return formatEvalOutput(response);
      }
    }, registrationOptions);
  }

  return {
    pool,
    config,
    prewarm(session) {
      if (disposed) return Promise.resolve();
      return pool.prewarm(session, { python: config.python, node: config.node });
    },
    destroy
  };
}

export const name = 'agent-optimizer-persistent-eval';
export const inject = ['tools'];
export const Config = PersistentEvalConfig;
export function apply(ctx, config = {}) {
  const service = applyPersistentEval(ctx, config);
  if (service) ctx.provide('persistentEval', service);
}
export default { name, inject, Config, apply };
