import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const EVAL_PYTHON_TOOL: 'eval_python';
export const EVAL_NODE_TOOL: 'eval_node';

export interface PersistentEvalOptions {
  enabled?: boolean;
  python?: boolean;
  node?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export declare const PersistentEvalConfig: z<PersistentEvalOptions>;

export interface PersistentEvalResponse {
  id?: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  result?: any;
  resultRepr?: string;
  error?: string;
  executionTimeMs?: number;
}

export declare function formatEvalOutput(resp: PersistentEvalResponse | null | undefined): string;

export interface PersistentEvalService {
  pool: any;
  config: PersistentEvalOptions;
  prewarm(session?: unknown): Promise<void>;
  destroy(): void;
}

export declare class StdioWorkerRunner {
  constructor(options: any);
  ensureStarted(): Promise<void>;
  execute(code: string, options?: any): Promise<PersistentEvalResponse>;
  destroy(): void;
}

export declare class DaemonPool {
  constructor(config?: any);
  prewarm(session?: any, options?: { python?: boolean; node?: boolean }): Promise<void>;
  getPythonRunner(session?: any): StdioWorkerRunner;
  getNodeRunner(session?: any): StdioWorkerRunner;
  destroySession(session?: any): void;
  destroyAll(): void;
}

export declare function applyPersistentEval(
  ctx: Context,
  rawConfig?: PersistentEvalOptions
): PersistentEvalService | null;
