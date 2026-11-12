import z from '@deepseek-ai/schemastery';
import { applyRuntimePolicy, RuntimePolicyConfig, RuntimePolicyManager, POLICY_SOURCE } from './runtime-policy.js';
import { applyFileMutationPolicy, FileMutationPolicyConfig, FileMutationPolicyManager, MUTATION_SOURCE } from './file-mutation-policy.js';
import { applyFailureRecovery, RecoveryRecord, RECOVERY_SOURCE, RETRY_TOOL, PAIRING_ERROR } from './failure-recovery.js';
import { applyCompositeTools, CompositeToolsConfig, READ_BATCH_TOOL, EDIT_BATCH_TOOL } from './composite-tools.js';
import { applyPersistentEval, PersistentEvalConfig, EVAL_PYTHON_TOOL, EVAL_NODE_TOOL, formatEvalOutput, StdioWorkerRunner, DaemonPool } from './persistent-eval/index.js';
import { applyConvergence, ConvergenceConfig, SOURCE as CONVERGENCE_SOURCE, GUIDANCE, REMINDER } from './convergence.js';
import { applyCustomPrompt, CustomPromptConfig, CustomPromptManager, SECTION_NAME as CUSTOM_PROMPT_SECTION, ENVIRONMENT_FACTS_SECTION, formatEnvironmentFacts, detectPythonEnv, resetPythonCacheForTesting } from './custom-prompt.js';
import { applyTelemetry, TelemetryConfig, AgentTelemetryManager, compareTurnSummaries } from './telemetry.js';

import { lintPrompt, fixPrompt, lintPromptFile, RULE_IDS as PROMPT_LINT_RULES } from './prompt-linter.js';

export const name = 'dsh-awesome-optimizer';
export const inject = ['systemPrompt', 'tools'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  runtimePolicy: RuntimePolicyConfig.default({}),
  policy: RuntimePolicyConfig.default({}),
  fileMutationPolicy: FileMutationPolicyConfig.default({}),
  mutationPolicy: FileMutationPolicyConfig.default({}),
  recoverFailedWrites: z.boolean().default(true),
  compositeTools: CompositeToolsConfig.default({}),
  persistentEval: PersistentEvalConfig.default({}),
  convergence: ConvergenceConfig.default({}),
  customPrompt: CustomPromptConfig.default({}),
  telemetry: TelemetryConfig.default({})
});

/**
 * Mount runtime policy guards, write recovery, composite batch tools,
 * persistent evaluation kernels, soft convergence guidance, and objective turn telemetry
 * around the official DSH agent loop.
 * Never disables @deepseek-ai/dsh-agent-loop or mutates agent/request parameters.
 */
export function apply(ctx, raw = {}) {
  const config = Config(raw);
  if (!config.enabled) return;

  const policyConfig = raw.runtimePolicy ?? raw.policy ?? config.runtimePolicy ?? {};
  const runtimePolicyManager = applyRuntimePolicy(ctx, policyConfig);
  if (runtimePolicyManager) ctx.provide('runtimePolicy', runtimePolicyManager);

  const mutationConfig = raw.fileMutationPolicy ?? raw.mutationPolicy ?? config.fileMutationPolicy ?? {};
  const fileMutationManager = applyFileMutationPolicy(ctx, mutationConfig);
  if (fileMutationManager) ctx.provide('fileMutationPolicy', fileMutationManager);

  if (config.recoverFailedWrites) {
    const recoveryService = applyFailureRecovery(ctx, {
      enabled: true,
      maxAttempts: policyConfig.recoveryAttemptLimit ?? config.runtimePolicy.recoveryAttemptLimit ?? 1
    });
    if (recoveryService) ctx.provide('failureRecovery', recoveryService);
  }

  const compositeConfig = raw.compositeTools ?? config.compositeTools ?? {};
  const compositeService = applyCompositeTools(ctx, compositeConfig);
  if (compositeService) ctx.provide('compositeTools', compositeService);

  const evalConfig = raw.persistentEval ?? config.persistentEval ?? {};
  const evalService = applyPersistentEval(ctx, evalConfig);
  if (evalService) ctx.provide('persistentEval', evalService);

  const convergenceConfig = raw.convergence ?? config.convergence ?? {};
  const convergenceService = applyConvergence(ctx, convergenceConfig);
  if (convergenceService) ctx.provide('convergenceGuidance', convergenceService);

  const customPromptConfig = raw.customPrompt ?? config.customPrompt ?? {};
  const customPromptManager = applyCustomPrompt(ctx, customPromptConfig);
  if (customPromptManager) ctx.provide('customPrompt', customPromptManager);

  const telemetryConfig = raw.telemetry ?? config.telemetry ?? {};
  const telemetryManager = applyTelemetry(ctx, telemetryConfig);
  if (telemetryManager) ctx.provide('agentTelemetry', telemetryManager);
}

export {
  RuntimePolicyManager,
  FileMutationPolicyManager,
  RecoveryRecord,
  AgentTelemetryManager,
  compareTurnSummaries,
  READ_BATCH_TOOL,
  EDIT_BATCH_TOOL,
  EVAL_PYTHON_TOOL,
  EVAL_NODE_TOOL,
  formatEvalOutput,
  applyPersistentEval,
  PersistentEvalConfig,
  StdioWorkerRunner,
  DaemonPool,
  RETRY_TOOL,
  PAIRING_ERROR,
  CONVERGENCE_SOURCE,
  RECOVERY_SOURCE,
  POLICY_SOURCE,
  MUTATION_SOURCE,
  CUSTOM_PROMPT_SECTION,
  ENVIRONMENT_FACTS_SECTION,
  formatEnvironmentFacts,
  detectPythonEnv,
  resetPythonCacheForTesting,
  CustomPromptManager,
  applyCustomPrompt,
  lintPrompt,
  fixPrompt,
  lintPromptFile,
  PROMPT_LINT_RULES,
  GUIDANCE,
  REMINDER
};

export default { name, inject, Config, apply };
