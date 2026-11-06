import type { Context } from '@deepseek-ai/cordis';

export interface PromptLintOptions {
  activeTools?: string[] | Set<string>;
  ctx?: Context;
  scope?: unknown;
}

export interface PromptLintStats {
  lines: number;
  chars: number;
  estimatedTokens: number;
}

export interface PromptLintIssue {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  message: string;
  fixable: boolean;
}

export interface PromptLintResult {
  score: number;
  stats: PromptLintStats;
  issues: PromptLintIssue[];
  fixesAvailable: boolean;
  filePath?: string;
}

export declare const RULE_IDS: {
  TOOL_PRESET_MISMATCH: string;
  UNVERIFIED_TOOL_DISABLEMENT: string;
  WEAK_MODALS: string;
  CONSTRAINT_CASING: string;
  LEGACY_JARGON: string;
  UNCLOSED_BACKTICKS: string;
};

export declare function resolveActiveToolNames(options?: PromptLintOptions): Set<string> | null;
export declare function lintPrompt(content?: string, options?: PromptLintOptions): PromptLintResult;
export declare function fixPrompt(content?: string, options?: PromptLintOptions): string;
export declare function lintPromptFile(filePath: string, options?: PromptLintOptions): PromptLintResult | null;
