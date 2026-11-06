import fs from 'node:fs';

export const RULE_IDS = {
  DEPRECATED_TOOLS: 'deprecated-tools',
  WEAK_MODALS: 'weak-modals',
  CONSTRAINT_CASING: 'constraint-casing',
  LEGACY_JARGON: 'legacy-jargon',
  UNCLOSED_BACKTICKS: 'unclosed-backticks'
};

const DEPRECATED_TOOLS = [
  { pattern: /\btool-pwsh\b/gi, name: 'tool-pwsh' },
  { pattern: /\btool-web\b/gi, name: 'tool-web' },
  { pattern: /\bweb-search-deepseek\b/gi, name: 'web-search-deepseek' },
  { pattern: /\bweb-fetch-http\b/gi, name: 'web-fetch-http' }
];

const WEAK_MODALS = [
  { pattern: /\b[Bb]ias(?:ed)?\s+toward\b/g, suggestion: 'Prioritize' },
  { pattern: /\b[Tt]ry\s+to\b/g, suggestion: 'Use direct imperative verbs' },
  { pattern: /\b[Pp]lease\b/g, suggestion: 'Omit conversational politeness filler' }
];

const LEGACY_JARGON = [
  { pattern: /\(no workflows,\s*ralph(?:,\s*or delegation)?\)/gi, suggestion: 'Remove obsolete orchestration/ralph notes' },
  { pattern: /\b(?:no workflows,\s*)?ralph(?:,\s*or delegation)?\b/gi, suggestion: 'Remove obsolete ralph reference' },
  { pattern: /\bdelegation\b/gi, suggestion: 'Remove sub-agent delegation note (DSH is single-agent)' }
];

const DIRECTIVE_CASING = [
  { pattern: /(?<=\b(?:is|are|be|operate|act|remain)\s+)strictly\b/g, replacement: 'STRICTLY' },
  { pattern: /(?<=[-\*\s]\s*)strictly\b/g, replacement: 'STRICTLY' },
  { pattern: /(?<=[-\*\s]\s*)never\b/g, replacement: 'NEVER' },
  { pattern: /(?<=[-\*\s]\s*)must\b/g, replacement: 'MUST' },
  { pattern: /(?<=[-\*\s]\s*)only\b/g, replacement: 'ONLY' }
];

/**
 * Scan prompt content and report actionable lint issues, stats, and a health score.
 * @param {string} content
 * @returns {object} Lint result with score, stats, issues, and fixable status.
 */
export function lintPrompt(content = '') {
  if (typeof content !== 'string') {
    content = String(content || '');
  }

  const lines = content.split('\n');
  const issues = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // 1. Deprecated Tools Check
    for (const dt of DEPRECATED_TOOLS) {
      if (dt.pattern.test(line)) {
        issues.push({
          ruleId: RULE_IDS.DEPRECATED_TOOLS,
          severity: 'warning',
          line: lineNum,
          message: `Detected deprecated or non-existent tool "${dt.name}". Prune to avoid model hallucination and attention noise.`,
          fixable: true
        });
        dt.pattern.lastIndex = 0;
      }
    }

    // 2. Legacy Jargon Check
    for (const lj of LEGACY_JARGON) {
      if (lj.pattern.test(line)) {
        issues.push({
          ruleId: RULE_IDS.LEGACY_JARGON,
          severity: 'warning',
          line: lineNum,
          message: `Detected obsolete framework jargon: ${lj.suggestion}.`,
          fixable: true
        });
        lj.pattern.lastIndex = 0;
      }
    }

    // 3. Weak Modals Check
    for (const wm of WEAK_MODALS) {
      if (wm.pattern.test(line)) {
        issues.push({
          ruleId: RULE_IDS.WEAK_MODALS,
          severity: 'info',
          line: lineNum,
          message: `Weak modal or soft preference detected. Suggestion: ${wm.suggestion}.`,
          fixable: true
        });
        wm.pattern.lastIndex = 0;
      }
    }

    // 4. Constraint Casing Check (RFC 2119 attention salience)
    for (const dc of DIRECTIVE_CASING) {
      if (dc.pattern.test(line)) {
        issues.push({
          ruleId: RULE_IDS.CONSTRAINT_CASING,
          severity: 'info',
          line: lineNum,
          message: `Constraint keyword should be uppercase (${dc.replacement}) for optimal model attention salience.`,
          fixable: true
        });
        dc.pattern.lastIndex = 0;
      }
    }

    // 5. Backtick Parity Check
    const singleBackticks = (line.match(/(?<!`)`(?!`)/g) || []).length;
    if (singleBackticks % 2 !== 0) {
      issues.push({
        ruleId: RULE_IDS.UNCLOSED_BACKTICKS,
        severity: 'error',
        line: lineNum,
        message: 'Unpaired single backtick detected on line; may corrupt prompt formatting.',
        fixable: false
      });
    }
  }

  // Calculate stats
  const chars = content.length;
  const lineCount = lines.length;
  const estimatedTokens = Math.ceil(chars / 3.8);

  // Calculate score (0 - 100)
  let deductions = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') deductions += 25;
    else if (issue.severity === 'warning') deductions += 10;
    else if (issue.severity === 'info') deductions += 4;
  }

  const score = Math.max(0, Math.min(100, 100 - deductions));

  return {
    score,
    stats: {
      lines: lineCount,
      chars,
      estimatedTokens
    },
    issues,
    fixesAvailable: issues.some(iss => iss.fixable)
  };
}

/**
 * Automatically apply safe, high-signal fixes to prompt text.
 * @param {string} content
 * @returns {string} Cleaned and optimized prompt text.
 */
export function fixPrompt(content = '') {
  if (typeof content !== 'string') return '';

  let fixed = content;

  // 1. Remove obsolete jargon / ralph
  fixed = fixed.replace(/\s*\(no workflows,\s*ralph(?:,\s*or delegation)?\)/gi, '');
  fixed = fixed.replace(/\b(?:no workflows,\s*)?ralph(?:,\s*or delegation)?\b/gi, '');

  // 2. Fix weak modals
  fixed = fixed.replace(/\bBias toward\b/g, 'Prioritize');
  fixed = fixed.replace(/\bbias toward\b/g, 'prioritize');

  // 3. Clean up deprecated tool phrasing
  fixed = fixed.replace(/-\s*Shell:\s*harness\s*`bash`\s*only\s*\(`tool-pwsh`\s*disabled\)\.\s*Launch\s*`pwsh\.exe`\s*from\s*`bash`\s*when\s*needed\./gi,
    '- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.');

  fixed = fixed.replace(/-\s*Web:\s*harness\s*`web-search-deepseek`,\s*`web-fetch-http`,\s*and\s*`tool-web`\s*are\s*disabled\.\s*Research\/fetch\s*STRICTLY\s*via\s*skills\s*\(([^)]+)\)\s*or\s*bash\s*CLIs\./gi,
    '- Web: Research/fetch STRICTLY via skills ($1) or bash CLIs.');

  // 4. Uppercase directive constraints
  for (const dc of DIRECTIVE_CASING) {
    fixed = fixed.replace(dc.pattern, dc.replacement);
  }

  return fixed;
}

/**
 * Read and lint a prompt file from disk.
 * @param {string} filePath
 * @returns {object|null}
 */
export function lintPromptFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      filePath,
      ...lintPrompt(content)
    };
  } catch (err) {
    return {
      filePath,
      score: 0,
      stats: { lines: 0, chars: 0, estimatedTokens: 0 },
      issues: [{
        ruleId: 'file-read-error',
        severity: 'error',
        line: 1,
        message: `Failed to read prompt file: ${err.message}`,
        fixable: false
      }],
      fixesAvailable: false
    };
  }
}
