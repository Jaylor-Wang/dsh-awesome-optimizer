import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export declare const name: 'agent-optimizer-custom-prompt';
export declare const inject: ['systemPrompt'];
export declare const SOURCE: 'optimizer-custom-prompt';
export declare const SECTION_NAME: 'optimizer:custom-prompt';
export declare const DEFAULT_SECTION_ORDER = 10300;

export type MergeStrategy = 'concat' | 'workspace-override' | 'global-only' | 'workspace-only';
export type PlacementMode = 'suffix' | 'prefix' | 'replace-persona-suffix' | 'section' | 'replace-all';

export interface CustomPromptOptions {
  enabled?: boolean;
  globalFile?: string;
  workspaceFile?: string;
  placement?: PlacementMode;
  sectionOrder?: number;
  sectionName?: string;
  mergeStrategy?: MergeStrategy;
  hotReload?: boolean;
  interpolate?: boolean;
}

export declare const CustomPromptConfig: z<CustomPromptOptions>;

export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
export declare function resolveGlobalPath(filePath?: string, env?: NodeJS.ProcessEnv): string;
export declare function resolveWorkspacePath(workspaceRoot?: string | null, relativeOrPath?: string): string | null;
export declare function resolveWorkspaceRoot(ctx: Context, context?: any): string;

export declare class CustomPromptManager {
  readonly config: CustomPromptOptions;
  readonly globalFilePath: string;
  constructor(options?: CustomPromptOptions);
  loadGlobal(): void;
  loadWorkspace(workspaceRoot?: string | null): string | null;
  getGlobalPrompt(): string;
  getWorkspacePrompt(workspaceRoot?: string | null): string;
  getEffectivePrompt(workspaceRoot?: string | null): string;
  reload(): void;
  dispose(): void;
}

export declare function applyCustomPrompt(ctx: Context, rawConfig?: CustomPromptOptions): CustomPromptManager | null;

export declare const Config: typeof CustomPromptConfig;
export declare function apply(ctx: Context, config?: CustomPromptOptions): void;

declare const _default: {
  name: typeof name;
  inject: typeof inject;
  Config: typeof Config;
  apply: typeof apply;
};
export default _default;
