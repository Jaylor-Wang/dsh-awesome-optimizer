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
import editRecoveryPlugin, { type EditRecoveryOptions, buildEditFailureHint } from 'dsh-awesome-optimizer/edit-recovery';
import readGuardPlugin, { type ReadGuardOptions, extractCodeOutline, formatCodeOutline } from 'dsh-awesome-optimizer/read-guard';
import compositePlugin, { type CompositeToolsOptions, FIND_AND_READ_TOOL, mergeMatchWindows } from 'dsh-awesome-optimizer/composite-tools';
import convergencePlugin, {
  buildGuidance,
  type ConvergenceOptions,
  type ConvergenceSignal
} from 'dsh-awesome-optimizer/convergence';
import customPromptPlugin, { type CustomPromptOptions } from 'dsh-awesome-optimizer/custom-prompt';
import persistentEvalPlugin, {
  applyPersistentEval,
  PY_WORKER_SCRIPT,
  NODE_WORKER_SCRIPT,
  type PersistentEvalOptions,
  type StdioWorkerExecuteOptions
} from 'dsh-awesome-optimizer/persistent-eval';
import telemetryPlugin, { type TelemetryOptions } from 'dsh-awesome-optimizer/telemetry';
const config: AgentOptimizerConfig = {
  enabled: true,
  runtimePolicy: { mode: 'enforce', noProgressLimit: 2, maxShellCommandBytes: 4096, maxInlineScriptBytes: 512 },
  fileMutationPolicy: { mode: 'observe', minLargeWriteBytes: 8192 },
  recoverFailedWrites: true,
  editRecovery: { enabled: true, contextLines: 6, maxSnippetLines: 20 },
  readGuard: { enabled: true, maxLineChars: 1500, injectTailOutline: true, maxOutlineEntries: 20, maxCacheEntries: 32, maxCacheBytes: 262144, astOutline: 'auto', astTimeoutMs: 750, astMaxOutputBytes: 262144, astGrepCommand: 'ast-grep' },
  compositeTools: { enabled: true, findAndRead: true, maxPatterns: 5, defaultContextLines: 5, maxFiles: 5, maxWindows: 10, maxWindowLines: 120, maxReadLines: 600, readConcurrency: 3, maxPreflightBytes: 2097152 },
  persistentEval: { enabled: true, python: true, node: true, timeoutMs: 15000, sanitizeEnv: true, requireShellTool: true },
  convergence: {
    enabled: true,
    mode: 'adaptive',
    injectGuidance: true,
    cooldownSteps: 6,
    serialReadThreshold: 4,
    longTailStepThreshold: 12,
    stallStepsThreshold: 6,
    softStepBudget: 8
  },
  customPrompt: { enabled: true, placement: 'replace-all', includeCliFacts: false },
  telemetry: { enabled: true, trackStreams: true }
};
const plugins: Plugin[] = [
  optimizer,
  policyPlugin,
  mutationPlugin,
  recoveryPlugin,
  editRecoveryPlugin,
  readGuardPlugin,
  compositePlugin,
  persistentEvalPlugin,
  convergencePlugin,
  customPromptPlugin,
  telemetryPlugin
];
const convergenceNotice: MessageSource = {
  kind: 'optimizer-convergence',
  form: 'notice',
  summary: 'Reassess remaining work.',
  signal: 'serial-exploration'
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
  EditRecoveryOptions,
  ReadGuardOptions,
  CompositeToolsOptions,
  PersistentEvalOptions,
  ConvergenceOptions,
  CustomPromptOptions,
  TelemetryOptions
] = [
  { mode: 'enforce', disallowChainedHeavyCommands: true },
  { mode: 'observe' },
  { enabled: true },
  { contextLines: 5, maxSnippetLines: 15, maxHintBytes: 1024 },
  { maxLineChars: 1500, injectTailOutline: true, maxOutlineEntries: 20 },
  { maxPatterns: 5, defaultContextLines: 5, maxFiles: 5, maxWindows: 10, maxLineChars: 1500, maxTotalBytes: 24576, maxWindowLines: 120, maxReadLines: 600, readConcurrency: 3, atomicEdits: true },
  { pythonCommand: 'python3', timeoutMs: 5000 },
  { softStepBudget: 6 },
  { placement: 'replace-all', includeCliFacts: true, extraEnvironmentFacts: ['- Custom fact'], maxWatchedWorkspaces: 16 },
  { trackStreams: true, onTurnSummary(summary) {
    const rate: number | null | undefined = summary.readGuard?.outlineCacheHitRate;
    const counts: number[] | null = summary.readGuard && [
      summary.readGuard.outlineCacheLookups, summary.readGuard.outlineCacheHits,
      summary.readGuard.outlineCacheMisses, summary.readGuard.outlineCacheBypasses,
      summary.readGuard.outlineCacheInvalidations
    ];
    const cacheRead: number | null = summary.usage.cacheReadTokens;
    const coverage: number = summary.cacheUsageCoverage.readReported;
    const editHints: number | undefined = summary.editRecovery?.hintsAttached;
    const compactions: number | undefined = summary.contextCompaction?.pressureCompactions;
    const reminders: number | undefined = summary.convergenceGuidance?.remindersSent;
    const lastSignal: ConvergenceSignal | null | undefined = summary.convergenceGuidance?.lastSignal;
    const lastStep: number | null | undefined = summary.convergenceGuidance?.lastReminderStep;
    const serialCount: number | undefined = summary.convergenceGuidance?.signals['serial-exploration'];
    void rate;
    void counts;
    void cacheRead;
    void coverage;
    void editHints;
    void compactions;
    void reminders;
    void lastSignal;
    void lastStep;
    void serialCount;
  } }
];

const workerExecOptions: StdioWorkerExecuteOptions = {
  action: 'eval',
  cwd: '/workspace/project',
  reset: false,
  timeoutMs: 1000,
  signal: new AbortController().signal
};

void buildGuidance({ hasFindAndRead: false, hasEditBatch: true });
void applyPersistentEval;
void PY_WORKER_SCRIPT;
void NODE_WORKER_SCRIPT;
void buildEditFailureHint('a\nb', 'c', { filePath: 'x.ts' });
void extractCodeOutline('export function demo() {}', { filePath: 'demo.ts' });
void formatCodeOutline('export function demo() {}', { filePath: 'demo.ts' });
void mergeMatchWindows([10, 12], 5);
void FIND_AND_READ_TOOL;
void workerExecOptions;
void config;
void plugins;
void convergenceNotice;
void recoveryNotice;
void sampleDelta;
void subConfigs;
