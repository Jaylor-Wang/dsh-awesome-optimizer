import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';

export const READ_BATCH_TOOL = 'read_batch';

export const CompositeToolsConfig = z.object({
  enabled: z.boolean().default(true),
  readBatch: z.boolean().default(true),
  maxBatchFiles: z.number().step(1).min(1).max(25).default(10),
  defaultLimitPerFile: z.number().step(1).min(1).max(2000).default(400)
});

/**
 * Register safe, read-only composite tools that collapse predictable multi-step reads
 * into a single model round-trip while routing every sub-call through ToolExecutionPipeline
 * so all sandbox policies, permissions, and file-observation hooks remain enforced.
 */
export function applyCompositeTools(ctx, rawConfig = {}) {
  const config = CompositeToolsConfig(rawConfig);
  if (!config.enabled || !config.readBatch) return null;

  const pipeline = new ToolExecutionPipeline(ctx);
  const statsBySession = new WeakMap();

  const stateFor = session => {
    if (!session) return null;
    let state = statsBySession.get(session);
    if (!state) {
      state = {
        batchesExecuted: 0,
        filesRequested: 0,
        filesSucceeded: 0,
        filesFailed: 0
      };
      statsBySession.set(session, state);
    }
    return state;
  };

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      statsBySession.set(session, {
        batchesExecuted: 0,
        filesRequested: 0,
        filesSucceeded: 0,
        filesFailed: 0
      });
    }
  });

  ctx.tools.register({
    name: READ_BATCH_TOOL,
    description: [
      `Read multiple UTF-8 text files (up to ${config.maxBatchFiles}) in a single tool call to avoid sequential single-file round trips.`,
      'Each entry dispatches through the native read tool pipeline with full sandbox and policy checks.',
      'Can be called alongside glob or grep in the same turn.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: config.maxBatchFiles,
          description: `List of file read specifications (1 to ${config.maxBatchFiles} files).`,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['file_path'],
            properties: {
              file_path: {
                type: 'string',
                description: 'Path to read, resolved by the filesystem backend.'
              },
              offset: {
                type: 'number',
                description: '1-based first line to return. Defaults to 1.'
              },
              limit: {
                type: 'number',
                description: `Maximum number of lines to return. Defaults to ${config.defaultLimitPerFile}.`
              }
            }
          }
        }
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const files = Array.isArray(args?.files) ? args.files : [];
      if (files.length === 0) {
        throw new HarnessError('read_batch requires at least one file entry in "files".', 'INVALID_READ_BATCH_ARGS');
      }
      if (files.length > config.maxBatchFiles) {
        throw new HarnessError(
          `read_batch received ${files.length} files, exceeding maxBatchFiles (${config.maxBatchFiles}).`,
          'READ_BATCH_LIMIT_EXCEEDED'
        );
      }

      const session = exec.agent?.session;
      const state = stateFor(session);
      if (state) {
        state.batchesExecuted++;
        state.filesRequested += files.length;
      }

      const subResults = await Promise.all(files.map(async (item, index) => {
        exec.signal.throwIfAborted();
        if (!item || typeof item.file_path !== 'string' || !item.file_path.trim()) {
          if (state) state.filesFailed++;
          return {
            filePath: String(item?.file_path ?? `<invalid-${index}>`),
            isError: true,
            text: 'Invalid file_path: must be a non-empty string.'
          };
        }
        const readArgs = {
          file_path: item.file_path,
          ...(typeof item.offset === 'number' ? { offset: item.offset } : {}),
          limit: typeof item.limit === 'number' ? item.limit : config.defaultLimitPerFile
        };
        const subCallId = `${exec.callId}:read-batch-${index}`;
        const log = {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId,
          name: 'read',
          arguments: readArgs
        };
        if (session?.append) {
          session.append('tool/ptc-dispatch-start', log);
        }
        const prepared = await pipeline.prepare({
          callId: subCallId,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: 'read',
          arguments: readArgs,
          agent: exec.agent,
          toolSet: exec.toolSet,
          signal: exec.signal
        });
        const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
        const result = await pipeline.complete(prepared.exec, outcome);
        if (session?.append) {
          session.append('tool/ptc-dispatch', {
            ...log,
            isError: result.isError,
            content: result.content,
            ...(result.error?.info ? { error: result.error.info } : {}),
            ...(result.meta === undefined ? {} : { meta: result.meta })
          });
        }
        for (const context of result.additionalContexts ?? []) {
          exec.deferContext(context);
        }
        if (result.isError) {
          if (state) state.filesFailed++;
          const msg = result.error?.message
            ?? result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')
            ?? 'Read failed';
          return {
            filePath: item.file_path,
            isError: true,
            text: `[ERROR] ${msg}`
          };
        }
        if (state) state.filesSucceeded++;
        const text = (result.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        return {
          filePath: item.file_path,
          isError: false,
          text
        };
      }));

      const allFailed = subResults.every(entry => entry.isError);
      const rendered = subResults
        .map(entry => `=== [${entry.isError ? 'ERROR' : 'FILE'}] ${entry.filePath} ===\n${entry.text}`)
        .join('\n\n');

      if (allFailed) {
        throw new HarnessError(rendered, 'READ_BATCH_ALL_FAILED');
      }
      return rendered;
    }
  }, { when: ({ agent }) => ctx.tools.get('read', agent) !== undefined });

  return {
    getStats(session) {
      const s = session ? statsBySession.get(session) : null;
      return s
        ? { ...s }
        : { batchesExecuted: 0, filesRequested: 0, filesSucceeded: 0, filesFailed: 0 };
    }
  };
}

export const name = 'agent-optimizer-composite-tools';
export const inject = ['tools'];
export const Config = CompositeToolsConfig;
export function apply(ctx, config = {}) {
  const service = applyCompositeTools(ctx, config);
  if (service) ctx.provide('compositeTools', service);
}
export default { name, inject, Config, apply };
