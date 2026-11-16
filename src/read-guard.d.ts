import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface ReadGuardOptions {
  enabled?: boolean;
  maxLineChars?: number;
  injectTailOutline?: boolean;
  maxOutlineEntries?: number;
  maxOutlineBytes?: number;
  maxInspectBytes?: number;
  /** Parsed-outline LRU entries per session/backend; 0 disables caching. Default: 32. */
  maxCacheEntries?: number;
  /** Maximum serialized cache payload per session/backend. Default: 262144. */
  maxCacheBytes?: number;
  /** auto: parse TSX/JSX and known lexical gaps on demand; off disables the CLI. */
  astOutline?: 'off' | 'auto' | 'always';
  /** Executable name or absolute path; executed without a shell. Default: ast-grep. */
  astGrepCommand?: string;
  /** CLI deadline in milliseconds. Default: 750. */
  astTimeoutMs?: number;
  /** Maximum CLI stdout bytes. Default: 262144. */
  astMaxOutputBytes?: number;
}

export interface ReadGuardStats {
  inspected: number;
  linesTruncated: number;
  outlinesInjected: number;
  /** Per-turn enabled lookups with a valid identity/version after successful preflight. */
  outlineCacheLookups: number;
  outlineCacheHits: number;
  /** Includes absent, stale, and evicted entries, even if subsequent parsing fails. */
  outlineCacheMisses: number;
  /** Successful preflights without caching: disabled, unversioned, or local-only backend. */
  outlineCacheBypasses: number;
  /** Mutation events clearing an existing session cache group, including in-flight work. */
  outlineCacheInvalidations: number;
  /** Hits / lookups in [0, 1]; null when no lookup occurred. */
  outlineCacheHitRate: number | null;
  astAttempts: number;
  astSucceeded: number;
  astFallbacks: number;
  astTimeouts: number;
}

export interface ReadGuardService {
  /** Detached per-turn snapshot; caches may survive turn boundaries. */
  getStats(session: unknown): ReadGuardStats;
}

export interface OutlineEntry {
  line: number;
  text: string;
  nested: boolean;
}

export declare const READ_GUARD_SOURCE: 'optimizer-read-guard';
export declare const ReadGuardConfig: z<ReadGuardOptions>;
export declare function truncateLongLines(text: string, maxLineChars?: number): string;
export declare function extractCodeOutline(
  content: string,
  options?: { filePath?: string; startLine?: number; endLine?: number }
): OutlineEntry[];
export declare function formatCodeOutline(
  content: string,
  options?: {
    filePath?: string;
    startLine?: number;
    endLine?: number;
    maxEntries?: number;
    maxBytes?: number;
  }
): string;
export declare function applyReadGuard(ctx: Context, rawConfig?: ReadGuardOptions): ReadGuardService | null;
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<ReadGuardOptions>;
export declare function apply(ctx: Context, config?: ReadGuardOptions): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
