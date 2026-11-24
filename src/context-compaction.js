/**
 * Opt into the host compaction seam without changing the official agent loop.
 * This keeps long sessions below provider context pressure when the selected
 * compaction backend is present, even if its own automatic listeners are off.
 */
import z from '@deepseek-ai/schemastery';

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';

export const ContextCompactionConfig = z.object({
  enabled: z.boolean().default(true),
  recoverOverflow: z.boolean().default(true)
});

function compactService(ctx) {
  try {
    const service = ctx.get('compaction');
    return service && typeof service.compactIfNeeded === 'function' ? service : null;
  } catch {
    return null;
  }
}

function log(ctx, level, message) {
  try { ctx.logger?.[level]?.(`[optimizer-context-compaction] ${message}`); } catch {}
}

export function applyContextCompaction(ctx, rawConfig = {}) {
  const config = ContextCompactionConfig(rawConfig);
  if (!config.enabled) return null;

  let disposed = false;
  let pressureAttempts = 0;
  let pressureCompactions = 0;
  let overflowAttempts = 0;
  let overflowCompactions = 0;
  let failures = 0;

  ctx.on('dispose', () => { disposed = true; });

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!disposed && !signal?.aborted) {
      const compaction = compactService(ctx);
      if (compaction) {
        pressureAttempts++;
        try {
          const result = await compaction.compactIfNeeded(agent, 'pressure', signal);
          if (result) pressureCompactions++;
        } catch (error) {
          if (!signal?.aborted) {
            failures++;
            log(ctx, 'warn', `pressure check failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    return next();
  });

  if (config.recoverOverflow) {
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (
        disposed || signal?.aborted || failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE
      ) return next();

      const compaction = compactService(ctx);
      if (!compaction) return next();

      const generation = agent.session?.surface?.replaceGeneration;
      overflowAttempts++;
      try {
        const result = await compaction.compactIfNeeded(agent, 'context-overflow', signal);
        const advanced = Number.isFinite(generation)
          && agent.session?.surface?.replaceGeneration > generation;
        if (result || advanced) overflowCompactions++;
        if (!disposed && !signal?.aborted && advanced) return { kind: 'retry' };
      } catch (error) {
        if (!signal?.aborted) {
          failures++;
          log(ctx, 'warn', `overflow recovery failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!disposed && Number.isFinite(generation) && agent.session?.surface?.replaceGeneration > generation) {
            overflowCompactions++;
            return { kind: 'retry' };
          }
        }
      }
      return next();
    });
  }

  return {
    getStats() {
      return {
        pressureAttempts,
        pressureCompactions,
        overflowAttempts,
        overflowCompactions,
        failures
      };
    }
  };
}

export const name = 'agent-optimizer-context-compaction';
export const inject = ['agent'];
export const Config = ContextCompactionConfig;
export function apply(ctx, config = {}) {
  const service = applyContextCompaction(ctx, config);
  if (service) ctx.provide('contextCompaction', service);
}
export default { name, inject, Config, apply };
