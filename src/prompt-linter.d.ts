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
  DEPRECATED_TOOLS: string;
  WEAK_MODALS: string;
  CONSTRAINT_CASING: string;
  LEGACY_JARGON: string;
  UNCLOSED_BACKTICKS: string;
};

export declare function lintPrompt(content?: string): PromptLintResult;
export declare function fixPrompt(content?: string): string;
export declare function lintPromptFile(filePath: string): PromptLintResult | null;
