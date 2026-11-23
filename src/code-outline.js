import path from 'node:path';
import { maskCode, parameterEnd } from './code-lexical.js';

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

const IDENTIFIER = '[\\p{ID_Start}_$][\\p{ID_Continue}$]*';
const jsFunction = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(async\\s+)?function\\s*\\*?\\s*(${IDENTIFIER})`, 'u');
const jsType = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?(class|interface|type|enum)\\s+(${IDENTIFIER})`, 'u');
const jsVariable = new RegExp(`^(export\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})(?:\\s*:[^=;]+)?\\s*=\\s*(async\\s+)?`, 'u');
const jsSingleArrow = new RegExp(`^(${IDENTIFIER})\\s*=>`, 'u');
const jsMethod = new RegExp(`^(?:(?:public|private|protected|static|readonly|override|abstract|get|set|async)\\s+)*\\*?\\s*(#?${IDENTIFIER})\\s*(?:<[^;{}]*>)?\\s*\\(`, 'u');
const pyDef = new RegExp(`^(async\\s+)?def\\s+(${IDENTIFIER})(?:\\[[^\\]]+\\])?\\s*\\(`, 'u');
const pyClass = new RegExp(`^class\\s+(${IDENTIFIER})(?:\\[[^\\]]+\\])?`, 'u');
const goFunc = /^func\s+(?:\([^)]*\)\s*)?([\p{ID_Start}_][\p{ID_Continue}_]*)(?:\[[^\]]+\])?\s*\(/u;
const goType = /^type\s+([\p{ID_Start}_][\p{ID_Continue}_]*)(?:\[[^\]]+\])?\s+(struct|interface)/u;
const rustFn = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern)\s+)*(fn\s+[\p{ID_Start}_][\p{ID_Continue}_]*(?:<[^;{}]*>)?\s*)\(/u;
const rustType = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:unsafe|auto)\s+)?(?:struct|enum|trait)\s+[\p{ID_Start}_][\p{ID_Continue}_]*/u;
const rustImpl = /^(?:unsafe\s+)?impl(?:<[^;{}]*>)?\s+[^{}]+/;

function scanDeclarations(content, language) {
  const masked = maskCode(content, language);
  const entries = [];
  let offset = 0;
  let depth = 0;
  let skipUntil = -1;
  for (const [index, line] of masked.split('\n').entries()) {
    const indent = line.length - line.trimStart().length;
    const start = offset + indent;
    const header = masked.slice(start, start + 8192);
    const push = (text, nested = language === 'py' ? indent > 0 : depth > 0) => {
      entries.push({ line: index + 1, text: truncateSig(text), nested });
    };
    const params = (prefix, from = 0) => {
      let cursor = from;
      while (/\s/.test(header[cursor] ?? '') && cursor < header.length) cursor++;
      if (header[cursor] === '<') {
        let angleDepth = 1;
        while (++cursor < header.length && angleDepth > 0) {
          if (header[cursor] === '<') angleDepth++;
          else if (header[cursor] === '>' && header[cursor - 1] !== '=') angleDepth--;
        }
      }
      while (/\s/.test(header[cursor] ?? '') && cursor < header.length) cursor++;
      const open = header[cursor] === '(' ? cursor : -1;
      const end = parameterEnd(header, open);
      if (end < 0) return null;
      skipUntil = Math.max(skipUntil, start + end);
      return { text: `${prefix}(${content.slice(start + open + 1, start + end).trim()})`, end };
    };
    if (start > skipUntil && line.trim()) {
      let match;
      const matches = regex => { match = header.match(regex); return match !== null; };
      if (language === 'js') {
        if (matches(jsFunction)) {
          const signature = params(`${match[1] ? 'export ' : ''}${match[2] ? 'async ' : ''}function ${match[3]}`, match[0].length);
          if (signature) push(signature.text);
        } else if (matches(jsType)) {
          const base = match[2] === 'class' ? header.slice(match[0].length).match(/^\s+extends\s+([\w$.]+)/)?.[1] : '';
          push(`${match[1] ? 'export ' : ''}${match[2]} ${match[3]}${base ? ` extends ${base}` : ''}`);
        } else if (matches(jsVariable)) {
          const prefix = `${match[1] ? 'export ' : ''}const ${match[2]}`;
          const rest = header.slice(match[0].length);
          const arrow = rest.match(/^(?:<[^;{}]+>\s*)?\(/);
          const expression = rest.match(/^function(?:\s+[\w$]+)?\s*\(/);
          if (arrow || expression) {
            const signature = params(`${prefix} = ${match[3] ? 'async ' : ''}`, match[0].length + (expression ? expression[0].length - 1 : 0));
            if (signature && (expression || /^(?:\s*:\s*[^;=]+)?\s*=>/.test(header.slice(signature.end + 1, signature.end + 1024)))) push(signature.text);
            else if (match[1]) push(prefix);
          } else {
            const single = rest.match(jsSingleArrow);
            if (single) push(`${prefix} = ${match[3] ? 'async ' : ''}(${single[1]})`);
            else if (match[1]) push(prefix);
          }
        } else if (depth > 0 && matches(jsMethod) && !CONTROL_WORDS.has(match[1])) {
          const signature = params(`${/\basync\s/.test(match[0]) ? 'async ' : ''}${match[1]}`, match[0].length - 1);
          if (signature && /^\s*(?::[^;=]+)?\s*\{/.test(header.slice(signature.end + 1, signature.end + 1024))) push(signature.text, true);
        }
      } else if (language === 'py') {
        if (matches(pyDef)) {
          const signature = params(`${match[1] ? 'async ' : ''}def ${match[2]}`, match[0].length - 1);
          if (signature) push(signature.text);
        } else if (matches(pyClass)) {
          const rest = header.slice(match[0].length);
          if (/^\s*\(/.test(rest)) {
            const signature = params(`class ${match[1]}`, match[0].length);
            if (signature) push(signature.text);
          } else if (/^\s*:/.test(rest)) push(`class ${match[1]}`);
        }
      } else if (language === 'go') {
        if (matches(goFunc)) {
          const open = match[0].lastIndexOf('(');
          const end = parameterEnd(header, open);
          if (end >= 0) { push(content.slice(start, start + end + 1)); skipUntil = start + end; }
        } else if (matches(goType)) push(`type ${match[1]} ${match[2]}`);
      } else if (language === 'rust') {
        if (matches(rustFn)) {
          const open = match[0].lastIndexOf('(');
          const end = parameterEnd(header, open);
          if (end >= 0) { push(content.slice(start, start + end + 1)); skipUntil = start + end; }
        } else if (matches(rustType)) push(match[0]);
        else if (matches(rustImpl)) push(match[0]);
      }
    }
    if (language !== 'py') for (const char of line) {
      if (char === '{') depth++;
      else if (char === '}') depth = Math.max(0, depth - 1);
    }
    offset += line.length + 1;
  }
  return entries;
}

function detectLanguage(filePath, content = '') {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'js';
  const ext = path.extname(filePath).toLowerCase();
  if (PY_EXTS.has(ext)) return 'py';
  if (GO_EXTS.has(ext)) return 'go';
  if (RS_EXTS.has(ext)) return 'rust';
  if (JS_TS_EXTS.has(ext)) return 'js';
  if (!ext && typeof content === 'string' && content.startsWith('#!')) {
    const firstLine = content.slice(0, 128).split('\n', 1)[0];
    if (/\bpython3?\b/.test(firstLine)) return 'py';
    if (/\b(?:node|deno|bun|tsx|ts-node)\b/.test(firstLine)) return 'js';
  }
  return null;
}

/** Check language support without reading file contents. */
export function supportsCodeOutline(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const ext = path.extname(filePath).toLowerCase();
  return JS_TS_EXTS.has(ext) || PY_EXTS.has(ext) || GO_EXTS.has(ext) || RS_EXTS.has(ext);
}

/** Extract lightweight symbols with 1-based line numbers. */
export function extractCodeOutline(content, { filePath = '', startLine = 1, endLine = Infinity } = {}) {
  if (typeof content !== 'string' || !content) return [];
  const language = detectLanguage(filePath, content);
  if (!language) return [];
  return scanDeclarations(content, language).filter(item => item.line >= startLine && item.line <= endLine);
}

/** Cacheable symbols are independent of the caller's current read offset. */
export function buildCodeOutline(content, filePath) {
  return { entries: extractCodeOutline(content, { filePath }), totalLines: content.split('\n').length };
}

/** Prefer top-level APIs and sample across the remaining file instead of its first page. */
export function formatOutlineEntries(entries, { startLine = 1, endLine = Infinity, maxEntries = 20, maxBytes = 1536 } = {}) {
  const all = entries.filter(item => item.line >= startLine && item.line <= endLine);
  const groups = [[], [], []];
  for (const entry of all) groups[entry.nested ? 2 : /^(?:export|pub\b)/.test(entry.text) ? 0 : 1].push(entry);
  for (let count = Math.min(all.length, Math.max(0, Math.floor(maxEntries))); count > 0; count--) {
    const shown = [];
    for (const group of groups) {
      const slots = Math.min(group.length, count - shown.length);
      for (let i = 0; i < slots; i++) {
        const index = slots === 1 ? 0 : Math.round(i * (group.length - 1) / (slots - 1));
        shown.push(group[index]);
      }
    }
    shown.sort((a, b) => a.line - b.line);
    const lines = shown.map(item => `L${item.line}: ${item.nested ? '  ' : ''}${item.text}`);
    if (all.length > count) lines.push(`... (+${all.length - count} more symbols)`);
    const output = lines.join('\n');
    if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;
  }
  return '';
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
  return formatOutlineEntries(extractCodeOutline(content, { filePath }), { startLine, endLine, maxEntries, maxBytes });
}
