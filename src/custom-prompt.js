import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'agent-optimizer-custom-prompt';
export const inject = ['systemPrompt'];
export const SOURCE = 'optimizer-custom-prompt';
export const SECTION_NAME = 'optimizer:custom-prompt';
export const DEFAULT_SECTION_ORDER = 10300;

export const CustomPromptConfig = z.object({
  enabled: z.boolean().default(true),
  globalFile: z.string().default('~/.dsh/SYSTEM.md'),
  workspaceFile: z.string().default('.dsh/SYSTEM.md'),
  placement: z.union(['suffix', 'prefix', 'replace-persona-suffix', 'section', 'replace-all']).default('suffix'),
  sectionOrder: z.number().default(DEFAULT_SECTION_ORDER),
  sectionName: z.string().default(SECTION_NAME),
  mergeStrategy: z.union(['concat', 'workspace-override', 'global-only', 'workspace-only']).default('concat'),
  hotReload: z.boolean().default(true),
  interpolate: z.boolean().default(false)
});

/**
 * Resolve `$DSH_HOME` or default `~/.dsh`.
 */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(os.homedir(), '.dsh');
}

/**
 * Resolve the global SYSTEM.md path.
 */
export function resolveGlobalPath(filePath, env = process.env) {
  if (!filePath) return path.join(resolveDshHome(env), 'SYSTEM.md');
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

/**
 * Resolve the workspace SYSTEM.md path.
 * Checks `<workspaceRoot>/.dsh/SYSTEM.md` first, then `<workspaceRoot>/SYSTEM.md`.
 */
export function resolveWorkspacePath(workspaceRoot, relativeOrPath = '.dsh/SYSTEM.md') {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return null;
  if (path.isAbsolute(relativeOrPath)) return relativeOrPath;

  const dotDshPath = path.resolve(workspaceRoot, relativeOrPath);
  if (fs.existsSync(dotDshPath)) return dotDshPath;

  const rootSystemPath = path.resolve(workspaceRoot, 'SYSTEM.md');
  if (fs.existsSync(rootSystemPath)) return rootSystemPath;

  return dotDshPath;
}

/**
 * Extract active workspace root from context.
 */
export function resolveWorkspaceRoot(ctx, context) {
  if (context?.workspaceRoot && typeof context.workspaceRoot === 'string') {
    return context.workspaceRoot;
  }
  const agent = context?.agent || (context?.scope?.session ? context.scope : null);
  const session = agent?.session || context?.session;
  if (session) {
    try {
      const wdService = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null;
      const cwd = wdService?.get ? wdService.get(session) : null;
      if (cwd) return cwd;
    } catch (_err) {}
  }
  return process.cwd();
}

/**
 * Reactive file-driven manager for custom SYSTEM.md prompts.
 */
export class CustomPromptManager {
  constructor(options = {}) {
    this.config = CustomPromptConfig(options);
    this.globalFilePath = resolveGlobalPath(this.config.globalFile);
    this.cachedGlobal = null;
    this.cachedWorkspace = new Map();
    this.watchers = new Map();
    this.debounceTimers = new Map();
    this.disposed = false;

    this.loadGlobal();
    if (this.config.hotReload) {
      this.watchPath(this.globalFilePath, () => this.loadGlobal());
    }
  }

  loadGlobal() {
    try {
      if (this.globalFilePath && fs.existsSync(this.globalFilePath)) {
        this.cachedGlobal = fs.readFileSync(this.globalFilePath, 'utf8').trim();
      } else {
        this.cachedGlobal = null;
      }
    } catch (_err) {
      this.cachedGlobal = null;
    }
  }

  loadWorkspace(workspaceRoot) {
    if (!workspaceRoot) return null;
    try {
      const wsPath = resolveWorkspacePath(workspaceRoot, this.config.workspaceFile);
      if (wsPath && fs.existsSync(wsPath)) {
        const content = fs.readFileSync(wsPath, 'utf8').trim();
        this.cachedWorkspace.set(workspaceRoot, content);
        if (this.config.hotReload && !this.watchers.has(wsPath)) {
          this.watchPath(wsPath, () => {
            this.loadWorkspace(workspaceRoot);
          });
        }
        return content;
      }
      this.cachedWorkspace.set(workspaceRoot, null);
      // Even if file doesn't exist yet, watch the directory so creation triggers load
      if (this.config.hotReload && wsPath && !this.watchers.has(wsPath)) {
        this.watchPath(wsPath, () => {
          this.loadWorkspace(workspaceRoot);
        });
      }
      return null;
    } catch (_err) {
      this.cachedWorkspace.set(workspaceRoot, null);
      return null;
    }
  }

  watchPath(targetPath, onChange) {
    if (!targetPath || this.disposed || this.watchers.has(targetPath)) return;
    try {
      const dir = path.dirname(targetPath);
      const filename = path.basename(targetPath);
      if (!fs.existsSync(dir)) {
        // If directory doesn't exist yet, try to create parent or skip until created
        return;
      }

      const watcher = fs.watch(dir, { persistent: false }, (_eventType, triggerName) => {
        if (!triggerName || triggerName === filename) {
          const existingTimer = this.debounceTimers.get(targetPath);
          if (existingTimer) clearTimeout(existingTimer);
          this.debounceTimers.set(
            targetPath,
            setTimeout(() => {
              if (this.disposed) return;
              onChange();
            }, 50)
          );
        }
      });
      watcher.on('error', () => {});
      this.watchers.set(targetPath, watcher);
    } catch (_err) {
      // Non-fatal
    }
  }

  getGlobalPrompt() {
    return this.cachedGlobal || '';
  }

  getWorkspacePrompt(workspaceRoot) {
    if (!workspaceRoot) return '';
    if (!this.cachedWorkspace.has(workspaceRoot)) {
      this.loadWorkspace(workspaceRoot);
    }
    return this.cachedWorkspace.get(workspaceRoot) || '';
  }

  getEffectivePrompt(workspaceRoot) {
    const globalText = this.getGlobalPrompt();
    const wsText = this.getWorkspacePrompt(workspaceRoot);
    const strategy = this.config.mergeStrategy;

    if (strategy === 'global-only') return globalText;
    if (strategy === 'workspace-only') return wsText;
    if (strategy === 'workspace-override') {
      return wsText || globalText;
    }

    // Default 'concat'
    if (globalText && wsText) {
      return `${globalText}\n\n${wsText}`;
    }
    return wsText || globalText;
  }

  reload() {
    this.loadGlobal();
    for (const wsRoot of this.cachedWorkspace.keys()) {
      this.loadWorkspace(wsRoot);
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch (_err) {}
    }
    this.watchers.clear();
    this.cachedWorkspace.clear();
  }
}

/**
 * Apply custom prompt system into Cordis runtime.
 */
export function applyCustomPrompt(ctx, rawConfig = {}) {
  const config = CustomPromptConfig(rawConfig);
  if (!config.enabled) return null;

  const manager = new CustomPromptManager(config);

  // If placement is 'suffix' or 'section', register section directly with systemPrompt service
  if ((config.placement === 'suffix' || config.placement === 'section') && ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: config.sectionName,
      order: config.sectionOrder,
      text: (context) => {
        const wsRoot = resolveWorkspaceRoot(ctx, context);
        return manager.getEffectivePrompt(wsRoot);
      },
      interpolate: config.interpolate
    });
  }

  // Also hook into waterfall 'system-prompt/assemble' for prefix or replace-persona-suffix
  ctx.on('system-prompt/assemble', (assembly, context) => {
    const wsRoot = resolveWorkspaceRoot(ctx, context);
    const customText = manager.getEffectivePrompt(wsRoot);
    if (!customText) return assembly;

    if (config.placement === 'replace-all') {
      return {
        ...assembly,
        sections: [
          {
            name: config.sectionName,
            text: customText,
            interpolate: config.interpolate
          }
        ]
      };
    }

    if (config.placement === 'replace-persona-suffix') {
      const sections = [...assembly.sections];
      const idx = sections.findIndex(s => s.name === 'deployment:persona-suffix');
      if (idx >= 0) {
        sections[idx] = { ...sections[idx], text: customText };
      } else {
        sections.push({
          name: config.sectionName,
          text: customText,
          interpolate: config.interpolate
        });
      }
      return { ...assembly, sections };
    }

    if (config.placement === 'prefix') {
      const sections = [
        {
          name: config.sectionName,
          text: customText,
          interpolate: config.interpolate
        },
        ...assembly.sections
      ];
      return { ...assembly, sections };
    }

    // For suffix/section: if ctx.systemPrompt.section was not available, ensure it gets injected
    if (!ctx.systemPrompt?.section) {
      const sections = [...assembly.sections];
      const existingIdx = sections.findIndex(s => s.name === config.sectionName);
      if (existingIdx >= 0) {
        sections[existingIdx] = { ...sections[existingIdx], text: customText };
      } else {
        sections.push({
          name: config.sectionName,
          text: customText,
          interpolate: config.interpolate
        });
      }
      return { ...assembly, sections };
    }

    return assembly;
  });

  ctx.on('dispose', () => {
    manager.dispose();
  });

  return manager;
}

export const Config = CustomPromptConfig;
export function apply(ctx, config = {}) {
  const service = applyCustomPrompt(ctx, config);
  if (service) ctx.provide('customPrompt', service);
}

export default { name, inject, Config, apply };
