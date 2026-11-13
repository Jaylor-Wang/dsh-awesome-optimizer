import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface EditRecoveryOptions {
  enabled?: boolean;
  contextLines?: number;
  maxSnippetLines?: number;
  maxInspectBytes?: number;
  maxHintBytes?: number;
  maxMultiMatchLocations?: number;
}

export interface EditRecoveryStats {
  inspected: number;
  hintsAttached: number;
  skipped: number;
}

export interface EditMatchLocation {
  startLine: number;
  endLine: number;
}

export type EditMatchResult =
  | { kind: 'multiple-matches'; count: number; locations: EditMatchLocation[]; totalLines: number }
  | { kind: 'whitespace-mismatch'; startLine: number; endLine: number; score: number; notes: string[]; totalLines: number }
  | { kind: 'fuzzy-match'; startLine: number; endLine: number; score: number; notes: string[]; totalLines: number }
  | { kind: 'no-close-match'; totalLines: number };

export interface EditRecoveryService {
  getStats(session: unknown): EditRecoveryStats;
}

export declare const EditRecoveryConfig: z<EditRecoveryOptions>;
export declare function isEditMatchFailure(errorMessage: string, errorCode?: string): boolean;
export declare function findBestEditMatch(
  content: string,
  oldString: string,
  options?: { maxMultiMatchLocations?: number }
): EditMatchResult;
export declare function buildEditFailureHint(
  content: string,
  oldString: string,
  options?: {
    filePath?: string;
    contextLines?: number;
    maxSnippetLines?: number;
    maxHintBytes?: number;
    maxMultiMatchLocations?: number;
  }
): string;
export declare function applyEditRecovery(ctx: Context, rawConfig?: EditRecoveryOptions): EditRecoveryService | null;

export declare const name: string;
export declare const inject: string[];
export declare const Config: z<EditRecoveryOptions>;
export declare function apply(ctx: Context, config?: EditRecoveryOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
