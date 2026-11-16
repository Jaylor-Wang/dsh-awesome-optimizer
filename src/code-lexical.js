/** Mask literals/comments without changing UTF-16 offsets or physical line numbers. */
export function maskCode(source, language) {
  const parts = [];
  let copied = 0;
  let index = 0;
  while (index < source.length) {
    const end = literalEnd(source, index, language);
    if (end > index) {
      parts.push(source.slice(copied, index), source.slice(index, end).replace(/[^\r\n]/g, ' '));
      index = end;
      copied = end;
    } else index++;
  }
  parts.push(source.slice(copied));
  return parts.join('');
}

function quotedEnd(source, start, quote, triple = false, multiline = false) {
  const delimiter = triple ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source.startsWith(delimiter, index)) return index + delimiter.length;
    if (!triple && !multiline && quote !== '`' && source[index] === '\n') return index;
    index++;
  }
  return source.length;
}

function commentEnd(source, start, nested) {
  let depth = 1;
  let index = start + 2;
  while (index < source.length) {
    if (nested && source.startsWith('/*', index)) { depth++; index += 2; }
    else if (source.startsWith('*/', index)) {
      index += 2;
      if (--depth === 0) return index;
    } else index++;
  }
  return source.length;
}

function regexEnd(source, start) {
  // Conservative expression-start recognition; division must remain visible.
  const before = source.slice(Math.max(0, start - 80), start).trimEnd();
  if (before && !/[=(:,\[!&|?{};>]$/.test(before) && !/\b(?:return|throw|yield|case|typeof|void|delete)$/.test(before)) return start;
  let inClass = false;
  for (let index = start + 1; index < source.length && source[index] !== '\n'; index++) {
    const char = source[index];
    if (char === '\\') { index++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index++;
      while (/[a-z]/i.test(source[index] ?? '')) index++;
      return index;
    }
  }
  return start;
}

function templateEnd(source, start, depth = 0) {
  if (depth > 64) return source.length;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '`') return index + 1;
    if (source.startsWith('${', index)) {
      index += 2;
      let braces = 1;
      while (index < source.length && braces > 0) {
        const end = literalEnd(source, index, 'js', depth + 1);
        if (end > index) { index = end; continue; }
        if (source[index] === '{') braces++;
        else if (source[index] === '}') braces--;
        index++;
      }
    } else index++;
  }
  return source.length;
}

function literalEnd(source, index, language, depth = 0) {
  const char = source[index];
  if (language === 'py' && char === '#') {
    const end = source.indexOf('\n', index);
    return end < 0 ? source.length : end;
  }
  if (language !== 'py' && source.startsWith('//', index)) {
    const end = source.indexOf('\n', index);
    return end < 0 ? source.length : end;
  }
  if (language !== 'py' && source.startsWith('/*', index)) return commentEnd(source, index, language === 'rust');
  if (language === 'rust') {
    if ((char === 'r' || char === 'b') && !/[\w]/.test(source[index - 1] ?? '')) {
      const raw = source.slice(index, index + 260).match(/^(?:br|r)(#{0,255})"/);
      if (raw) {
        const delimiter = `"${raw[1]}`;
        const end = source.indexOf(delimiter, index + raw[0].length);
        return end < 0 ? source.length : end + delimiter.length;
      }
    }
    // A lifetime such as 'a is not a character literal.
    if (char === "'") {
      const literal = source.slice(index, index + 20).match(/^'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u);
      return literal ? index + literal[0].length : index;
    }
  }
  if (char === '"' || char === "'") {
    return quotedEnd(source, index, char, language === 'py' && source.startsWith(char.repeat(3), index), language === 'rust');
  }
  if (char === '`' && language === 'js') return templateEnd(source, index, depth);
  if (char === '`' && language === 'go') {
    const end = source.indexOf('`', index + 1);
    return end < 0 ? source.length : end + 1;
  }
  if (char === '/' && language === 'js') return regexEnd(source, index);
  return index;
}

/** Read a bounded declaration header; nested default values and types stay balanced. */
export function parameterEnd(masked, open) {
  if (open < 0) return -1;
  let depth = 0;
  const end = Math.min(masked.length, open + 8192);
  for (let index = open; index < end; index++) {
    if (masked[index] === '(') depth++;
    else if (masked[index] === ')' && --depth === 0) return index;
  }
  return -1;
}
