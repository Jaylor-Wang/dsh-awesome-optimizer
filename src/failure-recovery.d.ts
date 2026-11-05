import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface FailureRecoveryOptions {
  enabled?: boolean;
  maxAttempts?: number;
}

export interface FailureRecoveryStats {
  attempted: number;
  succeeded: number;
  failed: number;
  invalidated: number;
}

export declare const RECOVERY_SOURCE: 'optimizer-write-recovery';
export declare const RETRY_TOOL: 'retry_failed_write';
export declare const PAIRING_ERROR: string;
export declare const FailureRecoveryConfig: z<FailureRecoveryOptions>;

export declare class RecoveryRecord {
  readonly owner: unknown;
  readonly callId: string;
  readonly rootCallId: string;
  readonly toolName: string;
  readonly args: { file_path: string; content: string };
  readonly targetPath: string;
  readonly argHash: string;
  readonly definition: unknown;
  readonly turn: number;
  readonly step: number;
  readonly category: string;
  attempts: number;
  readonly maxAttempts: number;
  notified: boolean;
  invalidatedReason: string | null;
  readonly createdAt: number;
  constructor(options: {
    owner: unknown;
    callId: string;
    rootCallId: string;
    toolName?: string;
    args: { file_path: string; content: string };
    definition: unknown;
    turn?: number;
    step?: number;
    category?: string;
    maxAttempts?: number;
  });
  isValid(agent: unknown, currentTurn: number, currentDefinition?: unknown): boolean;
  invalidate(reason: string): void;
  consume(): void;
}

export interface FailureRecoveryService {
  getRecord(session: unknown): RecoveryRecord | undefined;
  getStats(session: unknown): FailureRecoveryStats;
}

export declare function applyFailureRecovery(ctx: Context, options?: FailureRecoveryOptions): FailureRecoveryService | null;
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<FailureRecoveryOptions>;
export declare function apply(ctx: Context, config?: FailureRecoveryOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
