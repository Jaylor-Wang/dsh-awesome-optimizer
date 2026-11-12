import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import type { RuntimePolicyOptions } from './runtime-policy.d.ts';
import type { FileMutationPolicyOptions } from './file-mutation-policy.d.ts';
import type { CompositeToolsOptions } from './composite-tools.d.ts';
import type { ConvergenceOptions } from './convergence.d.ts';
import type { CustomPromptOptions } from './custom-prompt.d.ts';
import type { TelemetryOptions } from './telemetry.d.ts';

export interface AgentOptimizerConfig {
  enabled?: boolean;
  runtimePolicy?: RuntimePolicyOptions;
  policy?: RuntimePolicyOptions;
  fileMutationPolicy?: FileMutationPolicyOptions;
  mutationPolicy?: FileMutationPolicyOptions;
  recoverFailedWrites?: boolean;
  compositeTools?: CompositeToolsOptions;
  convergence?: ConvergenceOptions;
  customPrompt?: CustomPromptOptions;
  telemetry?: TelemetryOptions;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'optimizer-convergence': { kind: 'optimizer-convergence'; form: 'notice'; summary: string };
    'optimizer-write-recovery': { kind: 'optimizer-write-recovery'; form: 'notice'; summary: string; callId: string };
  }
}

export declare const name: string;
export declare const inject: string[];
export declare const Config: z<AgentOptimizerConfig>;
export declare function apply(ctx: Context, config?: AgentOptimizerConfig): void;

export {
  RuntimePolicyManager,
  POLICY_SOURCE,
  type RuntimePolicyOptions,
  type RuntimePolicySummary
} from './runtime-policy.d.ts';
export {
  FileMutationPolicyManager,
  MUTATION_SOURCE,
  type FileMutationPolicyOptions,
  type FileMutationPolicySummary
} from './file-mutation-policy.d.ts';
export {
  RecoveryRecord,
  RECOVERY_SOURCE,
  RETRY_TOOL,
  PAIRING_ERROR,
  type FailureRecoveryOptions,
  type FailureRecoveryStats,
  type FailureRecoveryService
} from './failure-recovery.d.ts';
export {
  READ_BATCH_TOOL,
  EDIT_BATCH_TOOL,
  type CompositeToolsOptions,
  type CompositeToolsStats,
  type CompositeToolsService
} from './composite-tools.d.ts';
export {
  SOURCE as CONVERGENCE_SOURCE,
  GUIDANCE,
  REMINDER,
  type ConvergenceOptions,
  type ConvergenceSummary,
  type ConvergenceService
} from './convergence.d.ts';
export {
  CustomPromptManager,
  applyCustomPrompt,
  SECTION_NAME as CUSTOM_PROMPT_SECTION,
  ENVIRONMENT_FACTS_SECTION,
  formatEnvironmentFacts,
  detectPythonEnv,
  resetPythonCacheForTesting,
  type PythonEnvInfo,
  type CustomPromptOptions,
  type MergeStrategy,
  type PlacementMode
} from './custom-prompt.d.ts';
export {
  AgentTelemetryManager,
  compareTurnSummaries,
  type TelemetryOptions,
  type TurnTelemetrySummary,
  type TurnComparisonDelta
} from './telemetry.d.ts';
export {
  lintPrompt,
  fixPrompt,
  lintPromptFile,
  RULE_IDS as PROMPT_LINT_RULES,
  type PromptLintStats,
  type PromptLintIssue,
  type PromptLintResult
} from './prompt-linter.d.ts';

declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
