import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface ConvergenceOptions {
  enabled?: boolean;
  injectGuidance?: boolean;
  stepInterval?: number;
  maxRemindersPerTurn?: number;
  softStepBudget?: number;
}

export interface ConvergenceSummary {
  steps: number;
  reminded: boolean;
  remindersSent: number;
  reminderCharsAdded: number;
}

export interface ConvergenceService {
  getSummary(session: unknown, turn?: number): ConvergenceSummary;
}

export declare const name: string;
export declare const inject: string[];
export declare const SOURCE: 'optimizer-convergence';
export declare const GUIDANCE: string;
export declare const REMINDER: string;
export declare const ConvergenceConfig: z<ConvergenceOptions>;
export declare const Config: z<ConvergenceOptions>;
export declare function applyConvergence(ctx: Context, raw?: ConvergenceOptions): ConvergenceService | null;
export declare function apply(ctx: Context, config?: ConvergenceOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
