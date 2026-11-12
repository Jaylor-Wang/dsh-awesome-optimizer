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
  timeoutMs: z.number().step(1).min(50).max(120000).default(15000),
  maxOutputBytes: z.number().step(1).min(64).max(65536).default(8192)
});

/**
 * Render friendly and compact text representation of execution output for agent response.
 */
export function formatEvalOutput(resp) {
  if (!resp) return 'No response returned from kernel.';

  const parts = [];

  if (resp.stdout && resp.stdout.length > 0) {
    parts.push(resp.stdout.trimEnd());
  }

  if (resp.result !== null && resp.result !== undefined) {
    const repr = resp.resultRepr || (typeof resp.result === 'object' ? JSON.stringify(resp.result) : String(resp.result));
    parts.push(`=> ${repr}`);
  }

  if (!resp.success) {
    if (resp.error) parts.push(`[Error: ${resp.error}]`);
    if (resp.stderr && resp.stderr.length > 0) {
      parts.push(resp.stderr.trimEnd());
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
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes
  });

  // Clean up session workers when session ends
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'session/destroy' || event?.type === 'session/close') {
      pool.destroySession(session);
    }
  });

  if (config.python) {
    ctx.tools.register({
      name: EVAL_PYTHON_TOOL,
      description: [
        'Execute Python code inside a persistent stateful kernel.',
        'Variables, functions, imports, and state persist across calls within the session.',
        'Use for exploratory calculations, data processing, kinematic/algorithmic solving, and intermediate analysis without writing temp files to disk.'
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
        exec?.signal?.throwIfAborted();
        const runner = pool.getPythonRunner(exec?.session);
        const code = args?.code || '';
        const reset = Boolean(args?.reset);

        const response = await runner.execute(code, { reset, timeoutMs: config.timeoutMs });
        return formatEvalOutput(response);
      }
    });
  }

  if (config.node) {
    ctx.tools.register({
      name: EVAL_NODE_TOOL,
      description: [
        'Execute JavaScript code inside a persistent stateful Node.js VM context.',
        'Variables, functions, and state persist across calls within the session. Supports top-level await.',
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
        exec?.signal?.throwIfAborted();
        const runner = pool.getNodeRunner(exec?.session);
        const code = args?.code || '';
        const reset = Boolean(args?.reset);

        const response = await runner.execute(code, { reset, timeoutMs: config.timeoutMs });
        return formatEvalOutput(response);
      }
    });
  }

  return {
    pool,
    config,
    destroy() {
      pool.destroyAll();
    }
  };
}
