import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import type { RuntimePolicySummary } from './runtime-policy.d.ts';
import type { FileMutationPolicySummary } from './file-mutation-policy.d.ts';
import type { FailureRecoveryStats } from './failure-recovery.d.ts';
import type { CompositeToolsStats } from './composite-tools.d.ts';

export interface TelemetryOptions {
  enabled?: boolean;
  trackStreams?: boolean;
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
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  turnOutcome: string | null;
  runtimePolicy: RuntimePolicySummary | null;
  fileMutationPolicy: FileMutationPolicySummary | null;
  failureRecovery: FailureRecoveryStats | null;
  compositeTools: CompositeToolsStats | null;
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
  wrapStream(options: any, next: () => AsyncIterable<any>): AsyncIterable<any>;
  getSummary(session?: unknown, turn?: number): TurnTelemetrySummary;
}

export declare function applyTelemetry(ctx: Context, rawConfig?: TelemetryOptions): AgentTelemetryManager | null;
export declare const name: string;
export declare const Config: z<TelemetryOptions>;
export declare function apply(ctx: Context, config?: TelemetryOptions): void;
declare const plugin: { name: typeof name; Config: typeof Config; apply: typeof apply };
export default plugin;
