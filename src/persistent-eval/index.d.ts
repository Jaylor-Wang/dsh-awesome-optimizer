import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const EVAL_PYTHON_TOOL: 'eval_python';
export const EVAL_NODE_TOOL: 'eval_node';

export interface PersistentEvalOptions {
  /** Default: true. Set false to disable local workers that run outside the DSH sandbox. */
  enabled?: boolean;
  python?: boolean;
  node?: boolean;
  pythonCommand?: string;
  /** Deadline for each worker startup and execution phase. Defaults to 15,000 ms. */
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
  pool: DaemonPool;
  config: PersistentEvalOptions;
  prewarm(session?: unknown): Promise<void>;
  destroy(): void;
}

export interface StdioWorkerRunnerOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
}

export interface StdioWorkerExecuteOptions {
  action?: 'eval' | 'ping' | 'reset';
  /** Session working directory to apply before reset or evaluation. */
  cwd?: string;
  reset?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DaemonPoolConfig {
  pythonCommand?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export declare class StdioWorkerRunner {
  isReady: boolean;
  isDestroyed: boolean;
  launchCount: number;
  constructor(options: StdioWorkerRunnerOptions);
  ensureStarted(signal?: AbortSignal): Promise<void>;
  execute(code: string, options?: StdioWorkerExecuteOptions): Promise<PersistentEvalResponse>;
  destroy(): void;
}

export declare class DaemonPool {
  constructor(config?: DaemonPoolConfig);
  prewarm(session?: unknown, options?: { python?: boolean; node?: boolean }): Promise<void>;
  getPythonRunner(session?: unknown): StdioWorkerRunner;
  getNodeRunner(session?: unknown): StdioWorkerRunner;
  destroySession(session?: unknown): void;
  destroyAll(): void;
}

export declare function applyPersistentEval(
  ctx: Context,
  rawConfig?: PersistentEvalOptions
): PersistentEvalService | null;
