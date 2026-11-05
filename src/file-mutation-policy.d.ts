import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export type FileMutationPolicyMode = 'off' | 'observe' | 'enforce';

export interface FileMutationPolicyOptions {
  mode?: FileMutationPolicyMode;
  minLargeWriteBytes?: number;
  reminderLimit?: number;
  allowFullReplacement?: (exec: any, normalizedPath: string) => boolean;
}

export interface FileMutationPolicySummary {
  largeWriteViolations: number;
  largeWritesBlocked: number;
  fullReplacementsAllowed: number;
  editsCount: number;
  observedFiles: number;
  createdFiles: number;
}

export declare const MUTATION_SOURCE: 'optimizer-file-mutation-policy';
export declare const FileMutationPolicyConfig: z<FileMutationPolicyOptions>;
export declare function fileExists(filePath?: string | null, cwd?: string): boolean;

export declare class FileMutationPolicyManager {
  readonly config: FileMutationPolicyOptions;
  constructor(config?: FileMutationPolicyOptions);
  onTurnStart(session: unknown, turn: number): void;
  onTurnEnd(session: unknown): void;
  onCwdChange(session: unknown, newCwd: string): void;
  evaluateToolExecution(session: unknown, exec: any, toolsService?: any): any;
  recordResult(session: unknown, exec: any, result: any): void;
  getSummary(session: unknown, turn?: number): FileMutationPolicySummary;
}

export declare function applyFileMutationPolicy(ctx: Context, rawConfig?: FileMutationPolicyOptions): FileMutationPolicyManager | null;
export declare const name: string;
export declare const Config: z<FileMutationPolicyOptions>;
export declare function apply(ctx: Context, config?: FileMutationPolicyOptions): void;
declare const plugin: { name: typeof name; Config: typeof Config; apply: typeof apply };
export default plugin;
