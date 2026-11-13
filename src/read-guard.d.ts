import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface ReadGuardOptions {
  enabled?: boolean;
  maxLineChars?: number;
  injectTailOutline?: boolean;
  maxOutlineEntries?: number;
  maxOutlineBytes?: number;
  maxInspectBytes?: number;
}

export interface ReadGuardStats {
  inspected: number;
  linesTruncated: number;
  outlinesInjected: number;
}

export interface ReadGuardService {
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
