import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeOutline } from './code-outline.js';

const CONFIG_PATH = fileURLToPath(new URL('./ast-outline-config.yml', import.meta.url));
const CLI_CWD = path.dirname(CONFIG_PATH);
const LANGUAGES = new Map([
  ...['.js', '.mjs', '.cjs', '.jsx'].map(ext => [ext, 'javascript']),
  ...['.ts', '.mts', '.cts'].map(ext => [ext, 'typescript']),
  ['.tsx', 'tsx'], ['.py', 'python'], ['.pyw', 'python'], ['.go', 'go'], ['.rs', 'rust']
]);

export function needsAstOutline(content, filePath, lexical, mode) {
  if (mode === 'off' || !LANGUAGES.has(path.extname(filePath).toLowerCase())) return false;
  if (mode === 'always') return true;
  const ext = path.extname(filePath).toLowerCase();
  // Known weak areas of the bounded lexical scanner, without a repository-wide scan.
  if (['.tsx', '.jsx'].includes(ext)) return true;
  if (['.ts', '.mts', '.cts'].includes(ext) && /^\s*(?:@|export\s+(?:declare\s+)?(?:namespace|module)\b)/m.test(content)) return true;
  return lexical.entries.length === 0 && /^\s*(?:(?:export|pub|async|unsafe)\s+)*(?:function|class|def|fn|func|impl|trait|interface)\b/m.test(content);
}

/** Parse only the authorized snapshot. Never pass a model-controlled path to the CLI. */
export function runAstOutline(content, filePath, {
  command = 'ast-grep', timeoutMs = 750, maxOutputBytes = 256 * 1024, signal, lexical
} = {}) {
  const language = LANGUAGES.get(path.extname(filePath).toLowerCase());
  if (!language || signal?.aborted) return Promise.resolve({ status: signal?.aborted ? 'aborted' : 'unsupported' });
  return new Promise(resolve => {
    let child;
    let settled = false;
    let failure;
    let bytes = 0;
    const chunks = [];
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    let killTimer;
    const stop = status => {
      if (settled || failure) return;
      failure = status;
      try { child?.kill('SIGKILL'); } catch {}
      // Do not hold a read hook indefinitely if the platform never emits close.
      killTimer = setTimeout(() => finish({ status }), 100);
      killTimer.unref?.();
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
        value !== undefined && !/KEY|PASSWORD|SECRET|TOKEN/i.test(name) && !/^DSH_/i.test(name)
      ));
      child = spawn(command, [
        'outline', '--stdin', '--lang', language, '--json=compact', '--view', 'expanded', '--items', 'structure',
        '--config', CONFIG_PATH, '--custom-languages', 'ignore', '--color', 'never', '--threads', '1'
      ], { cwd: CLI_CWD, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', error => finish({ status: error.code === 'ENOENT' ? 'unavailable' : 'error' }));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) stop('output-limit');
        else chunks.push(chunk);
      });
      // Drain diagnostics without retaining or exposing source excerpts.
      child.stderr.on('data', () => {});
      child.once('close', code => {
        if (failure) return finish({ status: failure });
        if (code !== 0) return finish({ status: 'error' });
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const entries = parseAstEntries(value, content.split('\n').length);
          // Bundled outline rules expose TS namespaces without their children.
          // Preserve lexically recognized children inside these AST-confirmed scopes.
          if (language === 'typescript') {
            const modules = value[0].items.filter(item => item.symbolType === 'module');
            if (modules.length) {
              const lexicalOutline = lexical ?? buildCodeOutline(content, filePath);
              for (const item of modules) {
                const start = item.range.start.line + 1;
                const end = item.range.end?.line + 1;
                for (const entry of lexicalOutline.entries) {
                  if (entry.line > start && entry.line <= end && !entries.some(existing => existing.line === entry.line)) {
                    entries.push({ ...entry, nested: true });
                  }
                }
              }
              entries.sort((a, b) => a.line - b.line);
            }
          }
          finish({ status: 'ok', entries });
        } catch { finish({ status: 'invalid-output' }); }
      });
      child.stdin.end(content, 'utf8');
      if (signal?.aborted) abort();
    } catch { finish({ status: 'error' }); }
  });
}

export function parseAstEntries(value, totalLines) {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0]?.items)) throw new Error('Invalid AST outline shape');
  const entries = [];
  const visit = (items, nested = false, depth = 0) => {
    if (depth > 32) throw new Error('AST outline depth exceeded');
    for (const item of items) {
      if (item.isImport || item.role === 'import') continue;
      const line = item.range?.start?.line;
      if (!Number.isInteger(line) || line < 0 || line >= totalLines || typeof item.signature !== 'string') throw new Error('Invalid AST item');
      let text = item.signature.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (item.isExported && !/^(?:export\b|pub\b)/.test(text)) text = `export ${text}`;
      entries.push({ line: line + 1, text: text.length > 96 ? `${text.slice(0, 93)}...` : text, nested });
      if (Array.isArray(item.members)) visit(item.members, true, depth + 1);
      if (Array.isArray(item.children)) visit(item.children, true, depth + 1);
    }
  };
  visit(value[0].items);
  return entries.sort((a, b) => a.line - b.line);
}

export async function buildAdaptiveOutline(content, filePath, options = {}, signal, stats) {
  const lexical = buildCodeOutline(content, filePath);
  if (!needsAstOutline(content, filePath, lexical, options.astOutline ?? 'auto')) return { ...lexical, engine: 'lexical' };
  if (stats) stats.astAttempts++;
  const result = await runAstOutline(content, filePath, {
    command: options.astGrepCommand, timeoutMs: options.astTimeoutMs,
    maxOutputBytes: options.astMaxOutputBytes, signal, lexical
  });
  if (result.status === 'ok') {
    if (stats) stats.astSucceeded++;
    return { entries: result.entries, totalLines: lexical.totalLines, engine: 'ast', astStatus: 'ok' };
  }
  if (stats) {
    stats.astFallbacks++;
    if (result.status === 'timeout') stats.astTimeouts++;
  }
  return { ...lexical, engine: 'lexical', astStatus: result.status };
}
