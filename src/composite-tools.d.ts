import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface CompositeToolsOptions {
  enabled?: boolean;
  findAndRead?: boolean;
  editBatch?: boolean;
  maxPatterns?: number;
  defaultContextLines?: number;
  maxFiles?: number;
  maxWindows?: number;
  /** Maximum lines requested in one merged read window. Default: 120. */
  maxWindowLines?: number;
  /** Maximum total lines requested per find_and_read call. Default: 600. */
  maxReadLines?: number;
  /** Maximum simultaneous reads in each budget-aware batch. Default: 3. */
  readConcurrency?: number;
  maxBatchEdits?: number;
  maxLineChars?: number;
  maxTotalBytes?: number;
  /** Require complete preflight and stop on the first execution failure. This does not roll back applied edits. */
  atomicEdits?: boolean;
}

export interface CompositeToolsStats {
  findExecuted: number;
  findPatternsSearched: number;
  findWindowsRead: number;
  findLinesRequested: number;
  findReadBatches: number;
  findFilesMatched: number;
  editBatchesExecuted: number;
  editsRequested: number;
  editsSucceeded: number;
  editsFailed: number;
}

export interface CompositeToolsService {
  getStats(session: unknown): CompositeToolsStats;
}

export interface ParsedGrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface MergedMatchWindow {
  start: number;
  end: number;
  matchedLines: number[];
}

export declare const FIND_AND_READ_TOOL: 'find_and_read';
export declare const EDIT_BATCH_TOOL: 'edit_batch';
export declare function truncateLongLines(text: string, maxLineChars?: number): string;
export declare function parseGrepOutput(text: string, meta?: unknown): ParsedGrepMatch[];
export declare function mergeMatchWindows(lineNumbers: number[], contextLines?: number, adjacentGap?: number): MergedMatchWindow[];
export declare const CompositeToolsConfig: z<CompositeToolsOptions>;
export declare function applyCompositeTools(ctx: Context, rawConfig?: CompositeToolsOptions): CompositeToolsService | null;
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<CompositeToolsOptions>;
export declare function apply(ctx: Context, config?: CompositeToolsOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
