import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'agent-optimizer-custom-prompt';
export const inject = ['systemPrompt'];
export const SOURCE = 'optimizer-custom-prompt';
export const SECTION_NAME = 'optimizer:custom-prompt';
export const ENVIRONMENT_FACTS_SECTION = 'optimizer:environment-facts';
export const DEFAULT_SECTION_ORDER = 10300;

export const CustomPromptConfig = z.object({
  enabled: z.boolean().default(true),
  globalFile: z.string().default('~/.dsh/SYSTEM.md'),
  workspaceFile: z.string().default('.dsh/SYSTEM.md'),
  placement: z.union(['replace-all', 'suffix']).default('replace-all'),
  sectionOrder: z.number().default(DEFAULT_SECTION_ORDER),
  sectionName: z.string().default(SECTION_NAME),
  mergeStrategy: z.union(['concat', 'workspace-override', 'global-only', 'workspace-only']).default('concat'),
  hotReload: z.boolean().default(true),
  maxWatchedWorkspaces: z.number().step(1).min(1).max(256).default(32),
  interpolate: z.boolean().default(false),
  injectEnvironmentFacts: z.boolean().default(true),
  includeCliFacts: z.boolean().default(true),
  extraEnvironmentFacts: z.array(z.string()).default([])
});
let cachedPython = undefined;

export function resetPythonCacheForTesting() {
  cachedPython = undefined;
}

/**
 * Safely detect active Python runtime with one-shot memoization and timeout guards.
 */
export function detectPythonEnv(spawnSyncFn = spawnSync) {
  if (cachedPython !== undefined) return cachedPython;
  for (const bin of ['python', 'python3']) {
    try {
      const res = spawnSyncFn(bin, ['--version'], { timeout: 600, encoding: 'utf8', windowsHide: true });
      if (res && res.status === 0) {
        const out = (res.stdout || res.stderr || '').trim();
        if (out.startsWith('Python')) {
          cachedPython = { bin, version: out };
          return cachedPython;
        }
      }
    } catch (_err) {}
  }
  cachedPython = null;
  return null;
}

/**
 * Generate compact host environment facts to eliminate exploratory probing turns (pwd, ls, node -v).
 */
export function formatEnvironmentFacts(processRef = process, pythonDetector = detectPythonEnv, options = {}) {
  const version = processRef?.version || 'unknown';
  const platform = processRef?.platform || 'unknown';
  const arch = processRef?.arch || 'unknown';
  const py = typeof pythonDetector === 'function' ? pythonDetector() : null;
  const pyInfo = py ? `, ${py.version} (${py.bin})` : ' (Python not detected; use Node.js for ad-hoc scripts)';
  const includeCliFacts = options?.includeCliFacts !== false;
  const lines = [
    '## Host Environment & Tooling Facts',
    `- Runtime: Node.js ${version}${pyInfo} on ${platform} (${arch}).`
  ];
  if (includeCliFacts) {
    lines.push(
      '- Standalone CLIs: playwright-cli, gh, ast-grep, and opencli are standalone binaries via bash; NEVER require/import as node modules.',
      '- Browser automation: playwright-cli blocks "file:" URLs (serve via loopback HTTP); \'screenshot\' takes selector target ONLY (no output filename; auto-saved to .playwright-cli/). NEVER probe via \'--help\' or \'--version\'.'
    );
  }
  lines.push(
    '- Zero startup probing: workspace context and host facts are already hydrated. NEVER run exploratory probing (pwd, ls, node -v, which).',
    '- Persistent evaluation (when available; trusted local use only): `eval_python` and `eval_node` retain state across turns; the session working directory is synchronized before execution and exposed as CWD. Python pre-imports math, re, json, time, collections, itertools, pathlib, difflib, csv. These local workers do not provide DSH sandbox isolation.',
    '- Ad-hoc scripts & cleanup: MUST write ad-hoc Node/Python scripts to disk via native write first and execute by file path; remove temporary artifacts directly via bash (rm -rf).'
  );
  if (Array.isArray(options?.extraFacts)) {
    for (const fact of options.extraFacts) {
      if (typeof fact === 'string' && fact.trim()) lines.push(fact);
    }
  }
  return lines.join('\n');
}

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
 * Honors `$DSH_HOME` when using the default `~/.dsh/SYSTEM.md` location.
 */
export function resolveGlobalPath(filePath, env = process.env) {
  if (!filePath || filePath === '~/.dsh/SYSTEM.md' || filePath === '~\\.dsh\\SYSTEM.md') {
    return path.join(resolveDshHome(env), 'SYSTEM.md');
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

function resolveWorkspaceCandidates(workspaceRoot, relativeOrPath = '.dsh/SYSTEM.md') {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return [];
  if (path.isAbsolute(relativeOrPath)) return [relativeOrPath];
  const primary = path.resolve(workspaceRoot, relativeOrPath);
  const fallback = path.resolve(workspaceRoot, 'SYSTEM.md');
  return primary === fallback ? [primary] : [primary, fallback];
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

function normalizeWatchKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
    this.workspaceRoots = new Map();
    this.watchers = new Map();
    this.watchOwners = new Map();
    this.watchCallbacks = new Map();
    this.parentChildren = new Map();
    this.workspaceWatchKeys = new Map();
    this.debounceTimers = new Map();
    this.disposed = false;

    this.loadGlobal();
    if (this.config.hotReload) {
      this.watchPath(this.globalFilePath, () => this.loadGlobal());
    }
  }

  _trackWatchOwner(key, ownerId) {
    let owners = this.watchOwners.get(key);
    if (!owners) {
      owners = new Set();
      this.watchOwners.set(key, owners);
    }
    owners.add(ownerId);
    if (ownerId !== '__global__') {
      let set = this.workspaceWatchKeys.get(ownerId);
      if (!set) {
        set = new Set();
        this.workspaceWatchKeys.set(ownerId, set);
      }
      set.add(key);
    }
  }

  _registerCallback(key, ownerId, onChange) {
    let byOwner = this.watchCallbacks.get(key);
    if (!byOwner) {
      byOwner = new Map();
      this.watchCallbacks.set(key, byOwner);
    }
    byOwner.set(ownerId, onChange);
  }

  _invokeCallbacks(key) {
    const byOwner = this.watchCallbacks.get(key);
    if (!byOwner) return;
    for (const cb of [...byOwner.values()]) {
      if (this.disposed) return;
      try { cb(); } catch (_err) {}
    }
  }

  _closeWatchHandleOnly(key) {
    const watcher = this.watchers.get(key);
    if (watcher) {
      try { watcher.close(); } catch (_err) {}
      this.watchers.delete(key);
    }
  }

  _closeWatchKey(key) {
    const timer = this.debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
    this._closeWatchHandleOnly(key);
    this.watchOwners.delete(key);
    this.watchCallbacks.delete(key);
    this.parentChildren.delete(key);
  }

  _releaseWatchKey(key, ownerId) {
    const byOwner = this.watchCallbacks.get(key);
    if (byOwner) {
      byOwner.delete(ownerId);
      if (byOwner.size === 0) this.watchCallbacks.delete(key);
    }
    const owners = this.watchOwners.get(key);
    if (owners) {
      owners.delete(ownerId);
      if (owners.size === 0) {
        this._closeWatchKey(key);
      }
    }
  }

  _setWorkspaceCache(workspaceKey, workspaceRoot, content) {
    this.cachedWorkspace.delete(workspaceKey);
    this.cachedWorkspace.set(workspaceKey, content);
    this.workspaceRoots.set(workspaceKey, workspaceRoot);
    const limit = this.config.maxWatchedWorkspaces ?? 32;
    while (this.cachedWorkspace.size > limit) {
      const oldest = this.cachedWorkspace.keys().next().value;
      this.cachedWorkspace.delete(oldest);
      this.workspaceRoots.delete(oldest);
      const keys = this.workspaceWatchKeys.get(oldest);
      if (keys) {
        for (const key of keys) this._releaseWatchKey(key, oldest);
        this.workspaceWatchKeys.delete(oldest);
      }
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
    const resolvedRoot = path.resolve(workspaceRoot);
    const workspaceKey = normalizeWatchKey(resolvedRoot);
    try {
      const wsPath = resolveWorkspacePath(resolvedRoot, this.config.workspaceFile);
      const content = wsPath && fs.existsSync(wsPath)
        ? fs.readFileSync(wsPath, 'utf8').trim()
        : null;
      this._setWorkspaceCache(workspaceKey, resolvedRoot, content);
      if (this.config.hotReload) {
        for (const candidate of resolveWorkspaceCandidates(resolvedRoot, this.config.workspaceFile)) {
          this.watchPath(candidate, () => this.loadWorkspace(resolvedRoot), workspaceKey);
        }
      }
      return content;
    } catch (_err) {
      this._setWorkspaceCache(workspaceKey, resolvedRoot, null);
      return null;
    }
  }

  _scheduleChange(debounceKey) {
    clearTimeout(this.debounceTimers.get(debounceKey));
    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey);
      if (this.disposed) return;
      this._invokeCallbacks(debounceKey);
    }, 50);
    timer.unref?.();
    this.debounceTimers.set(debounceKey, timer);
  }

  _attachFileWatcher(dir, filename, fileKey) {
    if (this.disposed || !fs.existsSync(dir) || this.watchers.has(fileKey)) return;
    const isWin = process.platform === 'win32';
    const matchesName = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
    const watcher = fs.watch(dir, { persistent: false }, (_eventType, triggerName) => {
      if (this.disposed) return;
      if (!fs.existsSync(dir)) {
        this._closeWatchHandleOnly(fileKey);
        this._scheduleChange(fileKey);
        return;
      }
      if (!triggerName || matchesName(triggerName, filename)) {
        this._scheduleChange(fileKey);
      }
    });
    watcher.on('error', () => {
      if (!fs.existsSync(dir)) this._closeWatchHandleOnly(fileKey);
    });
    this.watchers.set(fileKey, watcher);
  }

  watchPath(targetPath, onChange, ownerWorkspace = null) {
    if (!targetPath || this.disposed) return;
    try {
      const resolvedTarget = path.resolve(targetPath);
      const dir = path.dirname(resolvedTarget);
      const filename = path.basename(resolvedTarget);
      const isWin = process.platform === 'win32';
      const matchesName = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
      const ownerId = ownerWorkspace ? normalizeWatchKey(ownerWorkspace) : '__global__';
      const fileKey = `file:${normalizeWatchKey(resolvedTarget)}`;
      const parentKey = `dir:${normalizeWatchKey(dir)}`;

      this._registerCallback(fileKey, ownerId, onChange);
      this._trackWatchOwner(fileKey, ownerId);

      // Keep a parent watcher for nested subdirectories (e.g. .dsh/) so deletion + recreation re-attaches cleanly.
      const parentDir = path.dirname(dir);
      const subDirName = path.basename(dir);
      if (parentDir !== dir && fs.existsSync(parentDir)) {
        const shouldWatchParent = !fs.existsSync(dir)
          || (ownerWorkspace && normalizeWatchKey(dir) !== ownerId);
        if (shouldWatchParent) {
          let children = this.parentChildren.get(parentKey);
          if (!children) {
            children = new Map();
            this.parentChildren.set(parentKey, children);
          }
          children.set(fileKey, { dir, filename });
          this._trackWatchOwner(parentKey, ownerId);

          if (!this.watchers.has(parentKey)) {
            const parentWatcher = fs.watch(parentDir, { persistent: false }, (_eventType, triggerName) => {
              if (this.disposed) return;
              if (!triggerName || matchesName(triggerName, subDirName)) {
                const tracked = this.parentChildren.get(parentKey);
                if (!tracked) return;
                const dirExists = fs.existsSync(dir);
                for (const [childFileKey, meta] of tracked.entries()) {
                  if (!this.watchOwners.has(childFileKey)) continue;
                  if (dirExists) {
                    if (!this.watchers.has(childFileKey)) {
                      this._attachFileWatcher(meta.dir, meta.filename, childFileKey);
                    }
                    this._scheduleChange(childFileKey);
                  } else if (this.watchers.has(childFileKey)) {
                    this._closeWatchHandleOnly(childFileKey);
                    this._scheduleChange(childFileKey);
                  }
                }
              }
            });
            parentWatcher.on('error', () => {});
            this.watchers.set(parentKey, parentWatcher);
          }
        }
      }

      this._attachFileWatcher(dir, filename, fileKey);
    } catch (_err) {
      // Non-fatal
    }
  }

  getGlobalPrompt() {
    return this.cachedGlobal || '';
  }

  getWorkspacePrompt(workspaceRoot) {
    if (!workspaceRoot) return '';
    const workspaceKey = normalizeWatchKey(workspaceRoot);
    if (!this.cachedWorkspace.has(workspaceKey)) {
      this.loadWorkspace(workspaceRoot);
    } else {
      const value = this.cachedWorkspace.get(workspaceKey);
      this.cachedWorkspace.delete(workspaceKey);
      this.cachedWorkspace.set(workspaceKey, value);
    }
    return this.cachedWorkspace.get(workspaceKey) || '';
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
    for (const wsKey of [...this.cachedWorkspace.keys()]) {
      this.loadWorkspace(this.workspaceRoots.get(wsKey) ?? wsKey);
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
    this.watchOwners.clear();
    this.watchCallbacks.clear();
    this.parentChildren.clear();
    this.workspaceWatchKeys.clear();
    this.workspaceRoots.clear();
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

  // For suffix placement, register the section directly with the systemPrompt service
  if (config.placement === 'suffix' && ctx.systemPrompt?.section) {
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

  // Hook into the waterfall for both supported placement modes.
  ctx.on('system-prompt/assemble', (assembly, context) => {
    const wsRoot = resolveWorkspaceRoot(ctx, context);
    const customText = manager.getEffectivePrompt(wsRoot);
    const buildEnvFacts = () => ({
      name: ENVIRONMENT_FACTS_SECTION,
      text: formatEnvironmentFacts(process, detectPythonEnv, {
        includeCliFacts: config.includeCliFacts,
        extraFacts: config.extraEnvironmentFacts
      }),
      interpolate: false
    });

    if (!customText) {
      // Never strip official sections without a custom SYSTEM.md, but still honor injectEnvironmentFacts.
      if (!config.injectEnvironmentFacts || assembly.sections.some(s => s.name === ENVIRONMENT_FACTS_SECTION)) {
        return assembly;
      }
      return {
        ...assembly,
        sections: [...assembly.sections, buildEnvFacts()]
      };
    }

    if (config.placement === 'replace-all') {
      // Retain optimizer's own sections (e.g. convergence guidance) while stripping all other sections
      const optimizerSections = assembly.sections.filter(
        s => typeof s.name === 'string' && s.name.startsWith('optimizer:') && s.name !== config.sectionName && s.name !== ENVIRONMENT_FACTS_SECTION
      );
      const sections = [
        {
          name: config.sectionName,
          text: customText,
          interpolate: config.interpolate
        }
      ];
      if (config.injectEnvironmentFacts) {
        sections.push(buildEnvFacts());
      }
      sections.push(...optimizerSections);
      return {
        ...assembly,
        sections
      };
    }

    // For suffix: if ctx.systemPrompt.section was not available, ensure it gets injected
    const sections = [...assembly.sections];
    if (!ctx.systemPrompt?.section) {
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
    }
    if (config.injectEnvironmentFacts && !sections.some(s => s.name === ENVIRONMENT_FACTS_SECTION)) {
      sections.push(buildEnvFacts());
    }
    return { ...assembly, sections };
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      manager.dispose();
    });
  }

  return manager;
}

export const Config = CustomPromptConfig;
export function apply(ctx, config = {}) {
  const service = applyCustomPrompt(ctx, config);
  if (service) ctx.provide('customPrompt', service);
}

export default { name, inject, Config, apply };
