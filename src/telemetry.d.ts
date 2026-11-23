import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import type { RuntimePolicySummary } from './runtime-policy.d.ts';
import type { FileMutationPolicySummary } from './file-mutation-policy.d.ts';
import type { FailureRecoveryStats } from './failure-recovery.d.ts';
import type { EditRecoveryStats } from './edit-recovery.d.ts';
import type { CompositeToolsStats } from './composite-tools.d.ts';
import type { ReadGuardStats } from './read-guard.d.ts';
import type { ContextCompactionStats } from './context-compaction.d.ts';
import type { ConvergenceSummary } from './convergence.d.ts';

export interface TelemetryOptions {
  enabled?: boolean;
  trackStreams?: boolean;
  /** Opt-in HTTP diagnostics JSONL path; absolute, bounded to 8 MiB. */
  cacheDiagnosticsPath?: string;
  /** Called at turn end. The loop does not await it, and callback failures are ignored. */
  onTurnSummary?: (summary: TurnTelemetrySummary, session: unknown) => void;
}

export interface TurnTelemetrySummary {
  turn: number;
  steps: number;
  modelRequests: number;
  toolCalls: number;
  ptcSubCalls: number;
  toolBatches: number;
  maxBatchSize: number;
  parallelismRatio: number;
  failedToolCalls: number;
  reminders: number;
  recoveryNotices: number;
  prefixChanges: number;
  wallClockMs: number;
  modelStreamMs: number;
  firstTokenMs: {
    n: number;
    p50: number | null;
    p95: number | null;
  };
  usage: {
    /** Adapter-normalized uncached input, not the provider's raw prompt_tokens field. */
    inputTokens: number;
    outputTokens: number;
    /** Sum of reported adapter values only; null if none were reported. */
    cacheReadTokens: number | null;
    /** Sum of reported adapter values only; null if none were reported. */
    cacheWriteTokens: number | null;
  };
  /** Adapter stream coverage, not raw HTTP request coverage. Counts include explicitly reported zero. */
  cacheUsageCoverage: { streamAttempts: number; readReported: number; writeReported: number };
  turnOutcome: string | null;
  runtimePolicy: RuntimePolicySummary | null;
  fileMutationPolicy: FileMutationPolicySummary | null;
  failureRecovery: FailureRecoveryStats | null;
  editRecovery: EditRecoveryStats | null;
  compositeTools: CompositeToolsStats | null;
  readGuard: ReadGuardStats | null;
  contextCompaction: ContextCompactionStats | null;
  convergenceGuidance: ConvergenceSummary | null;
}

export interface TurnComparisonDelta {
  modelRequests: { baseline: number; candidate: number; delta: number };
  toolCalls: { baseline: number; candidate: number; delta: number };
  parallelismRatio: { baseline: number; candidate: number; delta: number };
  failedToolCalls: { baseline: number; candidate: number; delta: number };
  wallClockMs: { baseline: number; candidate: number; delta: number };
  inputTokens: { baseline: number; candidate: number; delta: number };
  outputTokens: { baseline: number; candidate: number; delta: number };
  prefixChanges: { baseline: number; candidate: number };
  bothCompleted: boolean;
}

export declare const TelemetryConfig: z<TelemetryOptions>;
export declare function compareTurnSummaries(
  baseline: Partial<TurnTelemetrySummary>,
  candidate: Partial<TurnTelemetrySummary>
): TurnComparisonDelta;

export declare class AgentTelemetryManager {
  readonly config: TelemetryOptions;
  constructor(ctx: Context, config?: TelemetryOptions);
  onSessionEvent(session: unknown, event: any): void;
  onSessionDisposed(session: unknown): void;
  wrapStream(options: any, next: () => AsyncIterable<any>): AsyncIterable<any>;
  /** Read the latest tracked turn without changing state. A missing/mismatched turn returns an empty summary; history is not retained. */
  getSummary(session?: unknown, turn?: number): TurnTelemetrySummary;
}

export declare function applyTelemetry(ctx: Context, rawConfig?: TelemetryOptions): AgentTelemetryManager | null;
export declare const name: string;
export declare const Config: z<TelemetryOptions>;
export declare function apply(ctx: Context, config?: TelemetryOptions): void;
declare const plugin: { name: typeof name; Config: typeof Config; apply: typeof apply };
export default plugin;
