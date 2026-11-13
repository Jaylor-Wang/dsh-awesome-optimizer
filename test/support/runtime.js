import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import OfficialLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService from '@deepseek-ai/dsh-tools';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { normalizePath } from '../../src/runtime-policy.js';
import optimizer from '../../src/index.js';

export const userMessage = text => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' }
});

export const call = (id = 'call-1', name = 'read', args = {}) => ({
  type: 'tool-call',
  id,
  name,
  arguments: JSON.stringify(args)
});

export async function* response(
  blocks = [{ type: 'text', text: 'Complete.' }],
  finish,
  usage = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 0 }
) {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
    if (block.type === 'tool-call') {
      yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    }
    yield { type: 'block-end', index, block };
  }
  if (usage) {
    yield { type: 'usage', usage };
  }
  yield {
    type: 'finish',
    reason: finish ?? { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' }
  };
}

class ScriptedAdapter extends LlmAdapter {
  constructor(owner, script) {
    super();
    this.owner = owner;
    this.script = script;
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      reasoning: { efforts: [{ id: 'xhigh', name: 'xhigh' }, { id: 'medium', name: 'medium' }] }
    });
  }

  async *stream(options) {
    const request = {
      ...options,
      messages: structuredClone(options.messages),
      tools: structuredClone(options.tools ?? [])
    };
    this.owner.requests.push(request);
    const index = this.owner.requests.length - 1;
    assert.ok(index < 100, 'Offline fixture exceeded its request guard');
    const step = typeof this.script === 'function' ? this.script(request, index, this.owner) : this.script[index];
    assert.ok(step, `Missing scripted response at step index ${index}`);
    yield* typeof step === 'function' ? step(options, this.owner) : response(step);
  }
}

/**
 * Mount the unchanged official @deepseek-ai/dsh-agent-loop alongside dsh-awesome-optimizer.
 */
export async function createTestRuntime({
  optimizerEnabled = true,
  optimizerConfig = {},
  script = [[{ type: 'text', text: 'Complete.' }]],
  files = { 'README.md': 'line 1\nline 2\nline 3' },
  readHandler,
  writeHandler,
  editHandler,
  bashHandler,
  grepHandler,
  configureTools,
  workingDirectory,
  agentOptions
} = {}) {
  const ctx = new Context();
  const fibers = [];
  const handles = [];
  const virtualFs = new Map(Object.entries(files));
  const owner = {
    ctx,
    requests: [],
    errors: [],
    calls: [],
    events: [],
    handles,
    virtualFs
  };

  const mount = async (plugin, config = {}) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };

  try {
    await mount(SessionProjectionRegistry);
    await mount(SessionStore);
    await mount(AgentRegistry);
    await mount(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: 'Complete the task accurately.'
    });
    await mount(LlmRuntime);
    await mount(ToolsService);
    await mount(nativeExecutor);

    const fsFixture = {
      async resolve(filePath, opts) {
        opts?.signal?.throwIfAborted();
        const targetKey = normalizePath(filePath, opts?.cwd ?? '');
        return {
          targetKey,
          displayPath: filePath
        };
      },
      async stat(target, signal) {
        signal?.throwIfAborted();
        if (!target) return undefined;
        for (const [key, content] of virtualFs.entries()) {
          if (normalizePath(key) === normalizePath(target.targetKey) || key === target.displayPath) {
            return {
              version: '1',
              type: 'file',
              size: Buffer.byteLength(content, 'utf8')
            };
          }
        }
        return undefined;
      }
    };
    ctx.provide('fs', fsFixture);
    if (workingDirectory) {
      ctx.provide('workingDirectory', {
        get(_session) {
          return workingDirectory;
        }
      });
    }

    ctx.on('agent/error', ({ error }) => owner.errors.push(error));
    ctx.on('session/event', (_session, event) => owner.events.push(event));

    ctx.llm.registerAdapter(['offline'], new ScriptedAdapter(owner, script));

    ctx.tools.register({
      name: 'read',
      description: 'Read a UTF-8 text file.',
      parameters: {
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        }
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        owner.calls.push({ id: exec.callId, name: 'read', args });
        if (readHandler) return readHandler(args, exec, virtualFs);
        if (!virtualFs.has(args.file_path)) {
          throw new Error(`ENOENT: no such file or directory, open '${args.file_path}'`);
        }
        const raw = virtualFs.get(args.file_path);
        const lines = raw.split('\n');
        const start = Math.max(0, (args.offset ?? 1) - 1);
        const count = args.limit ?? lines.length;
        return lines.slice(start, start + count).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      }
    });

    ctx.tools.register({
      name: 'write',
      description: 'Write a UTF-8 text file.',
      parameters: {
        type: 'object',
        required: ['file_path', 'content'],
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
          justification: { type: 'string' },
          sandbox_permissions: { type: 'string' }
        }
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        owner.calls.push({ id: exec.callId, name: 'write', args });
        if (writeHandler) return writeHandler(args, exec, virtualFs);
        virtualFs.set(args.file_path, args.content);
        return `Created/updated ${args.file_path}`;
      }
    });

    ctx.tools.register({
      name: 'edit',
      description: 'Edit an existing UTF-8 text file.',
      parameters: {
        type: 'object',
        required: ['file_path', 'old_string', 'new_string'],
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' }
        }
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        owner.calls.push({ id: exec.callId, name: 'edit', args });
        if (editHandler) return editHandler(args, exec, virtualFs);
        const existing = virtualFs.get(args.file_path);
        if (existing === undefined) throw new Error(`ENOENT: ${args.file_path}`);
        if (!existing.includes(args.old_string)) throw new Error('old_string not found');
        virtualFs.set(args.file_path, existing.replace(args.old_string, args.new_string));
        return `Edited ${args.file_path}`;
      }
    });

    ctx.tools.register({
      name: 'bash',
      description: 'Execute a bash command.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
          workdir: { type: 'string' },
          description: { type: 'string' }
        }
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        owner.calls.push({ id: exec.callId, name: 'bash', args });
        if (bashHandler) return bashHandler(args, exec);
        return `[exit code: 0]\n${args.command}`;
      }
    });
    ctx.tools.register({
      name: 'grep',
      description: 'Search file contents with a regular expression.',
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' }
        }
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        owner.calls.push({ id: exec.callId, name: 'grep', args });
        if (grepHandler) return grepHandler(args, exec, virtualFs);
        const re = new RegExp(args.pattern);
        const groups = [];
        let total = 0;
        for (const [filePath, raw] of virtualFs.entries()) {
          if (args.path && !filePath.startsWith(args.path)) continue;
          if (args.include) {
            const extMatch = args.include.match(/^\*\.(\w+)$/);
            if (extMatch && !filePath.endsWith(`.${extMatch[1]}`)) continue;
          }
          const hits = [];
          const lines = raw.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              hits.push(`Line ${i + 1}: ${lines[i]}`);
              total++;
            }
          }
          if (hits.length > 0) {
            groups.push(`${filePath}\n${hits.join('\n')}`);
          }
        }
        if (total === 0) return 'No matches found';
        return `Found ${total} ${total === 1 ? 'match' : 'matches'}\n\n${groups.join('\n\n')}`;
      }
    });


    if (configureTools) await configureTools(ctx, owner);

    // Mount the unchanged official agent loop
    await mount(OfficialLoop);

    // Mount our non-invasive optimizer plugin
    await mount(optimizer, {
      enabled: optimizerEnabled,
      ...optimizerConfig
    });

    owner.telemetry = ctx.get('agentTelemetry');
    owner.runtimePolicy = ctx.get('runtimePolicy');
    owner.fileMutationPolicy = ctx.get('fileMutationPolicy');
    owner.failureRecovery = ctx.get('failureRecovery');
    owner.compositeTools = ctx.get('compositeTools');
    owner.readGuard = ctx.get('readGuard');
    owner.editRecovery = ctx.get('editRecovery');

    const handle = await ctx.agents.create({
      sessionId: `optimizer-test-${randomUUID()}`,
      agentOptions: agentOptions ?? {
        provider: 'offline',
        model: 'scripted',
        reasoningEffort: 'xhigh'
      }
    });
    handles.push(handle);
    owner.agent = handle.agent;

    owner.run = async (text = 'Execute the requested task.') => {
      owner.agent.followup(userMessage(text));
      await owner.agent.whenIdle();
      return owner;
    };

    owner.dispose = async () => {
      const customPrompt = ctx.get('customPrompt');
      if (customPrompt && typeof customPrompt.dispose === 'function') {
        customPrompt.dispose();
      }
      const evalService = ctx.get('persistentEval');
      if (evalService && typeof evalService.destroy === 'function') {
        evalService.destroy();
      }
      for (const h of [...handles].reverse()) await h.dispose();
      for (const f of [...fibers].reverse()) await f.dispose();
    };

    return owner;
  } catch (error) {
    for (const h of [...handles].reverse()) await h.dispose();
    for (const f of [...fibers].reverse()) await f.dispose();
    throw error;
  }
}
