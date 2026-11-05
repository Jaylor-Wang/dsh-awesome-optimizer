import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface CompositeToolsOptions {
  enabled?: boolean;
  readBatch?: boolean;
  editBatch?: boolean;
  maxBatchFiles?: number;
  maxBatchEdits?: number;
  defaultLimitPerFile?: number;
}

export interface CompositeToolsStats {
  batchesExecuted: number;
  filesRequested: number;
  filesSucceeded: number;
  filesFailed: number;
  editBatchesExecuted: number;
  editsRequested: number;
  editsSucceeded: number;
  editsFailed: number;
}

export interface CompositeToolsService {
  getStats(session: unknown): CompositeToolsStats;
}

export declare const READ_BATCH_TOOL: 'read_batch';
export declare const EDIT_BATCH_TOOL: 'edit_batch';
export declare const CompositeToolsConfig: z<CompositeToolsOptions>;
export declare function applyCompositeTools(ctx: Context, rawConfig?: CompositeToolsOptions): CompositeToolsService | null;
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<CompositeToolsOptions>;
export declare function apply(ctx: Context, config?: CompositeToolsOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
