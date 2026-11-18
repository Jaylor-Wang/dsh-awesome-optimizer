import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface ContextCompactionOptions {
  /** Enable the optimizer-owned bridge to the host compaction service. Default: true. */
  enabled?: boolean;
  /** Compact and retry provider-confirmed context-window overflows. Default: true. */
  recoverOverflow?: boolean;
}

export interface ContextCompactionStats {
  pressureAttempts: number;
  pressureCompactions: number;
  overflowAttempts: number;
  overflowCompactions: number;
  failures: number;
}

export interface ContextCompactionService {
  getStats(): ContextCompactionStats;
}

export declare const CONTEXT_WINDOW_EXCEEDED_CODE: 'CONTEXT_WINDOW_EXCEEDED';
export declare const ContextCompactionConfig: z<ContextCompactionOptions>;
export declare function applyContextCompaction(
  ctx: Context,
  rawConfig?: ContextCompactionOptions
): ContextCompactionService | null;
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<ContextCompactionOptions>;
export declare function apply(ctx: Context, config?: ContextCompactionOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
