import type { Plugin } from '@deepseek-ai/cordis';
import type { MessageSource } from '@deepseek-ai/dsh-llm';
import optimizer, {
  type AgentOptimizerConfig,
  type TurnTelemetrySummary,
  compareTurnSummaries
} from 'dsh-awesome-optimizer';
import policyPlugin, { type RuntimePolicyOptions } from 'dsh-awesome-optimizer/policy';
import mutationPlugin, { type FileMutationPolicyOptions } from 'dsh-awesome-optimizer/mutation-policy';
import recoveryPlugin, { type FailureRecoveryOptions } from 'dsh-awesome-optimizer/recovery';
import compositePlugin, { type CompositeToolsOptions } from 'dsh-awesome-optimizer/composite-tools';
import convergencePlugin, { type ConvergenceOptions } from 'dsh-awesome-optimizer/convergence';
import customPromptPlugin, { type CustomPromptOptions } from 'dsh-awesome-optimizer/custom-prompt';
import { applyPersistentEval, type PersistentEvalOptions, type StdioWorkerExecuteOptions } from 'dsh-awesome-optimizer/persistent-eval';
import telemetryPlugin, { type TelemetryOptions } from 'dsh-awesome-optimizer/telemetry';
const config: AgentOptimizerConfig = {
  enabled: true,
  runtimePolicy: { mode: 'enforce', noProgressLimit: 2, maxShellCommandBytes: 4096, maxInlineScriptBytes: 512 },
  fileMutationPolicy: { mode: 'observe', minLargeWriteBytes: 8192 },
  recoverFailedWrites: true,
  compositeTools: { enabled: true, readBatch: true, maxBatchFiles: 10 },
  persistentEval: { enabled: true, python: true, node: true, timeoutMs: 15000 },
  convergence: { enabled: true, injectGuidance: true, softStepBudget: 8 },
  customPrompt: { enabled: true, placement: 'replace-all', includeCliFacts: false },
  telemetry: { enabled: true, trackStreams: true }
};
const plugins: Plugin[] = [
  optimizer,
  policyPlugin,
  mutationPlugin,
  recoveryPlugin,
  compositePlugin,
  convergencePlugin,
  customPromptPlugin,
  telemetryPlugin
];
const convergenceNotice: MessageSource = {
  kind: 'optimizer-convergence',
  form: 'notice',
  summary: 'Reassess remaining work.'
};

const recoveryNotice: MessageSource = {
  kind: 'optimizer-write-recovery',
  form: 'notice',
  summary: 'Retry failed write.',
  callId: 'call-1'
};

const sampleDelta = compareTurnSummaries(
  { modelRequests: 4, toolCalls: 3, parallelismRatio: 1 } as Partial<TurnTelemetrySummary>,
  { modelRequests: 2, toolCalls: 1, parallelismRatio: 1 } as Partial<TurnTelemetrySummary>
);

const subConfigs: [
  RuntimePolicyOptions,
  FileMutationPolicyOptions,
  FailureRecoveryOptions,
  CompositeToolsOptions,
  PersistentEvalOptions,
  ConvergenceOptions,
  CustomPromptOptions,
  TelemetryOptions
] = [
  { mode: 'enforce', disallowChainedHeavyCommands: true },
  { mode: 'observe' },
  { enabled: true },
  { maxBatchFiles: 8, maxLineChars: 1500, maxTotalBytes: 32768, atomicEdits: true },
  { pythonCommand: 'python3', timeoutMs: 5000 },
  { softStepBudget: 6 },
  { placement: 'replace-all', includeCliFacts: true, extraEnvironmentFacts: ['- Custom fact'] },
  { trackStreams: true }
];

const workerExecOptions: StdioWorkerExecuteOptions = {
  action: 'eval',
  reset: false,
  timeoutMs: 1000,
  signal: new AbortController().signal
};

void applyPersistentEval;
void workerExecOptions;
void config;
void plugins;
void convergenceNotice;
void recoveryNotice;
void sampleDelta;
void subConfigs;
