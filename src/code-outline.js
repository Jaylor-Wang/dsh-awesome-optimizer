import path from 'node:path';

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const PY_EXTS = new Set(['.py', '.pyw']);
const GO_EXTS = new Set(['.go']);
const RS_EXTS = new Set(['.rs']);

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'throw', 'await', 'yield', 'new', 'typeof', 'delete'
]);

function truncateSig(sig, maxLen = 96) {
  const clean = sig.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}...`;
}

function scanJsTs(lines) {
  const entries = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNum = i + 1;

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }

    const indent = raw.length - raw.trimStart().length;

    // Top-level declarations (indent <= 2)
    if (indent <= 2) {
      let m = trimmed.match(/^(export\s+(?:default\s+)?)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (m) {
        const prefix = `${m[1] ? 'export ' : ''}${m[2] ? 'async ' : ''}function ${m[3]}(${m[4]})`;
        entries.push({ line: lineNum, text: truncateSig(prefix), nested: false });
        continue;
      }

      m = trimmed.match(/^(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?/);
      if (m) {
        const prefix = `${m[1] ? 'export ' : ''}class ${m[2]}${m[3] ? ` extends ${m[3]}` : ''}`;
        entries.push({ line: lineNum, text: truncateSig(prefix), nested: false });
        continue;
      }

      m = trimmed.match(/^(export\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (m) {
        entries.push({ line: lineNum, text: truncateSig(`${m[1] ? 'export ' : ''}${m[2]} ${m[3]}`), nested: false });
        continue;
      }

      m = trimmed.match(/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?(?:\(([^)]*)\)\s*=>|function\s*\(([^)]*)\))/);
      if (m) {
        const params = m[3] ?? m[4] ?? '';
        entries.push({ line: lineNum, text: truncateSig(`export const ${m[1]} = ${m[2] ? 'async ' : ''}(${params})`), nested: false });
        continue;
      }

      m = trimmed.match(/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
      if (m) {
        entries.push({ line: lineNum, text: truncateSig(`export const ${m[1]}`), nested: false });
        continue;
      }
    }

    // Class / object method definitions at shallow indent (1 tab or 2-4 spaces)
    if (indent >= 1 && indent <= 4) {
      const m = trimmed.match(/^(?:(?:public|private|protected|static|readonly|override|get|set|async)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/);
      if (m && !CONTROL_WORDS.has(m[1])) {
        const isAsync = /\basync\s+/.test(trimmed.slice(0, trimmed.indexOf(m[1])));
        entries.push({
          line: lineNum,
          text: truncateSig(`${isAsync ? 'async ' : ''}${m[1]}(${m[2]})`),
          nested: true
        });
      }
    }
  }
  return entries;
}

function scanPython(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent > 4) continue;

    let m = trimmed.match(/^class\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*:/);
    if (m) {
      entries.push({
        line: i + 1,
        text: truncateSig(`class ${m[1]}${m[2] ? `(${m[2]})` : ''}`),
        nested: indent > 0
      });
      continue;
    }

    m = trimmed.match(/^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (m) {
      entries.push({
        line: i + 1,
        text: truncateSig(`${m[1] ? 'async ' : ''}def ${m[2]}(${m[3]})`),
        nested: indent > 0
      });
    }
  }
  return entries;
}

function scanGo(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('func ') || raw.startsWith('type ')) {
      const m = raw.match(/^(func\s+(?:\([^)]+\)\s*)?[A-Za-z_]\w*\([^)]*\)|type\s+[A-Za-z_]\w*\s+(?:struct|interface))/);
      if (m) entries.push({ line: i + 1, text: truncateSig(m[1]), nested: false });
    }
  }
  return entries;
}

function scanRust(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent > 4) continue;
    const m = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn\s+[A-Za-z_]\w*\([^)]*\)|struct\s+[A-Za-z_]\w*|enum\s+[A-Za-z_]\w*|trait\s+[A-Za-z_]\w*|impl(?:<[^>]*>)?\s+[^{]+)/);
    if (m) {
      entries.push({ line: i + 1, text: truncateSig(m[0]), nested: indent > 0 });
    }
  }
  return entries;
}

/**
 * Extract lightweight symbol entries with 1-based line numbers for supported source languages.
 */
export function extractCodeOutline(content, { filePath = '', startLine = 1, endLine = Infinity } = {}) {
  if (typeof content !== 'string' || !content) return [];
  const ext = path.extname(filePath).toLowerCase();
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  let raw;
  if (PY_EXTS.has(ext)) raw = scanPython(lines);
  else if (GO_EXTS.has(ext)) raw = scanGo(lines);
  else if (RS_EXTS.has(ext)) raw = scanRust(lines);
  else if (JS_TS_EXTS.has(ext) || !ext) raw = scanJsTs(lines);
  else return [];

  return raw.filter(item => item.line >= startLine && item.line <= endLine);
}

/**
 * Format bounded structural outline lines for a file slice.
 */
export function formatCodeOutline(content, {
  filePath = '',
  startLine = 1,
  endLine = Infinity,
  maxEntries = 20,
  maxBytes = 1536
} = {}) {
  const all = extractCodeOutline(content, { filePath, startLine, endLine });
  if (all.length === 0) return '';

  const shown = all.slice(0, maxEntries);
  const lines = shown.map(item => `L${item.line}: ${item.nested ? '  ' : ''}${item.text}`);
  if (all.length > shown.length) {
    lines.push(`... (+${all.length - shown.length} more symbols)`);
  }

  let output = lines.join('\n');
  if (Buffer.byteLength(output, 'utf8') > maxBytes) {
    const trimmed = [];
    let bytes = 0;
    for (const line of lines) {
      const b = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + b > maxBytes - 48) break;
      trimmed.push(line);
      bytes += b;
    }
    trimmed.push('... (outline truncated)');
    output = trimmed.join('\n');
  }
  return output;
}
