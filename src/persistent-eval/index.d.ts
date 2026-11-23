import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const EVAL_PYTHON_TOOL: 'eval_python';
export declare const EVAL_NODE_TOOL: 'eval_node';
export declare const PY_WORKER_SCRIPT: string;
export declare const NODE_WORKER_SCRIPT: string;

export interface PersistentEvalOptions {
  /** Default: true. Set false to disable local workers that run outside the DSH sandbox. */
  enabled?: boolean;
  python?: boolean;
  node?: boolean;
  pythonCommand?: string;
  /** Deadline for each worker startup and execution phase. Defaults to 15,000 ms. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Strip sensitive credential and DSH_* variables from inherited worker env. Default: true. */
  sanitizeEnv?: boolean;
  /** Admit eval tools only when the host agent has `bash` admitted. Default: true. */
  requireShellTool?: boolean;
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
  sanitizeEnv?: boolean;
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
  sanitizeEnv?: boolean;
  maxDisposedKeys?: number;
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
  reviveSession(session?: unknown): boolean;
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

export declare const name: string;
export declare const inject: string[];
export declare const Config: z<PersistentEvalOptions>;
export declare function apply(ctx: Context, config?: PersistentEvalOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
