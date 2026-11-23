import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export type ConvergenceMode = 'adaptive' | 'periodic';
export type ConvergenceSignal = 'serial-exploration' | 'long-tail-stall' | 'periodic';

export interface ConvergenceOptions {
  enabled?: boolean;
  mode?: ConvergenceMode;
  injectGuidance?: boolean;
  stepInterval?: number;
  cooldownSteps?: number;
  serialReadThreshold?: number;
  longTailStepThreshold?: number;
  stallStepsThreshold?: number;
  maxRemindersPerTurn?: number;
  softStepBudget?: number;
}

export interface ConvergenceSummary {
  steps: number;
  reminded: boolean;
  remindersSent: number;
  reminderCharsAdded: number;
  lastReminderStep: number | null;
  lastSignal: ConvergenceSignal | null;
  signals: Record<ConvergenceSignal, number>;
  consecutiveSerialReads: number;
  stepsWithoutProgress: number;
}

export interface ConvergenceService {
  getSummary(session: unknown, turn?: number): ConvergenceSummary;
}

export interface BuildGuidanceOptions {
  hasFindAndRead?: boolean;
  hasEditBatch?: boolean;
}

export declare const name: string;
export declare const inject: string[];
export declare const SOURCE: 'optimizer-convergence';
export declare function buildGuidance(options?: BuildGuidanceOptions): string;
export declare const GUIDANCE: string;
export declare const REMINDER: string;
export declare const ConvergenceConfig: z<ConvergenceOptions>;
export declare const Config: z<ConvergenceOptions>;
export declare function applyConvergence(ctx: Context, raw?: ConvergenceOptions): ConvergenceService | null;
export declare function apply(ctx: Context, config?: ConvergenceOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
