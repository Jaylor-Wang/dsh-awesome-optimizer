import fs from 'node:fs';

export const RULE_IDS = {
  TOOL_PRESET_MISMATCH: 'tool-preset-mismatch',
  UNVERIFIED_TOOL_DISABLEMENT: 'unverified-tool-disablement',
  WEAK_MODALS: 'weak-modals',
  CONSTRAINT_CASING: 'constraint-casing',
  LEGACY_JARGON: 'legacy-jargon',
  UNCLOSED_BACKTICKS: 'unclosed-backticks',
  CLI_REQUIRE_CONFUSION: 'cli-require-confusion'
};

const CLI_REQUIRE_PATTERNS = [
  {
    pattern: /\b(?:require|import)\s*\(?['"](?:playwright|gh|ast-grep|opencli)['"]\)?/gi,
    suggestion: 'Standalone CLIs (playwright-cli, gh, ast-grep, opencli) must be executed via bash, not imported as node modules'
  }
];

const WEAK_MODALS = [
  { pattern: /\b[Bb]ias(?:ed)?\s+toward\b/g, suggestion: 'Prioritize', fixable: true },
  { pattern: /\b[Tt]ry\s+to\b/g, suggestion: 'Use direct imperative verbs', fixable: false },
  { pattern: /\b[Pp]lease\b/g, suggestion: 'Omit conversational politeness filler', fixable: false }
];

const LEGACY_JARGON = [
  { pattern: /\(no workflows,\s*ralph(?:,\s*or delegation)?\)/gi, suggestion: 'Remove obsolete orchestration/ralph notes' },
  { pattern: /\b(?:no workflows,\s*)?ralph(?:,\s*or delegation)?\b/gi, suggestion: 'Remove obsolete ralph reference' },
  { pattern: /\bdelegation\b/gi, suggestion: 'Remove sub-agent delegation note (DSH is single-agent)' }
];

const DIRECTIVE_CASING = [
  { pattern: /(?<=\b(?:is|are|be|operate|act|remain)\s+)strictly\b/g, replacement: 'STRICTLY' },
  { pattern: /(?<=[-\*]\s+)strictly\b/g, replacement: 'STRICTLY' },
  { pattern: /(?<=[-\*]\s+)never\b/g, replacement: 'NEVER' },
  { pattern: /(?<=[-\*]\s+)must\b/g, replacement: 'MUST' },
  { pattern: /(?<=:\s*)only\b/g, replacement: 'ONLY' },
  { pattern: /(?<=[-\*]\s+)only\b/g, replacement: 'ONLY' }
];

/**
 * Extract active tool names from options or Cordis Context.
 * @param {object} options
 * @returns {Set<string>|null}
 */
export function resolveActiveToolNames(options = {}) {
  if (options.activeTools) {
    if (options.activeTools instanceof Set) return options.activeTools;
    if (Array.isArray(options.activeTools)) return new Set(options.activeTools);
  }

  const ctx = options.ctx;
  if (ctx?.tools) {
    try {
      if (typeof ctx.tools.definitions === 'function') {
        const defs = ctx.tools.definitions(options.scope);
        if (Array.isArray(defs)) {
          return new Set(defs.map(d => d.name));
        }
      }
    } catch (_err) {}
  }

  return null;
}

/**
 * Extract candidate tool names mentioned in negative/disablement clauses.
 * Matches patterns like: `(`tool-pwsh` disabled)`, `harness `web-search-deepseek` ... disabled`
 * @param {string} line
 * @returns {string[]}
 */
function extractDisabledToolReferences(line = '') {
  const tools = [];
  // Pattern 1: (`tool-xyz` disabled) or (`tool-xyz` is disabled)
  const p1 = /\(`?([a-zA-Z0-9_-]+)`?\s+(?:is\s+)?disabled\)/gi;
  let m1;
  while ((m1 = p1.exec(line)) !== null) {
    tools.push(m1[1]);
  }

  // Pattern 2: harness `tool-a`, `tool-b` are disabled
  const p2 = /(?:harness\s+)?((?:`[a-zA-Z0-9_-]+`(?:\s*,\s*|\s+and\s+)?)+)\s+(?:is|are)\s+disabled/gi;
  let m2;
  while ((m2 = p2.exec(line)) !== null) {
    const list = m2[1].match(/`([a-zA-Z0-9_-]+)`/g);
    if (list) {
      for (const item of list) {
        tools.push(item.replace(/`/g, ''));
      }
    }
  }

  return Array.from(new Set(tools));
}

/**
 * Scan prompt content and report actionable lint issues, stats, and a health score.
 * Evaluates tool references dynamically against currently loaded preset/plugins when provided.
 * @param {string} content
 * @param {object} [options]
 * @param {string[]|Set<string>} [options.activeTools] - Set of active tool names in the profile/preset
 * @param {object} [options.ctx] - Cordis Context with tools service
 * @param {object} [options.scope] - Agent scope key
 * @returns {object} Lint result with score, stats, issues, and fixable status.
 */
export function lintPrompt(content = '', options = {}) {
  if (typeof content !== 'string') {
    content = String(content || '');
  }

  const activeTools = resolveActiveToolNames(options);
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

    // 1. Tool References & Disablement Analysis (Dynamic ground-truth check)
    const disabledTools = extractDisabledToolReferences(line);
    for (const toolName of disabledTools) {
      if (activeTools !== null) {
        // Preset ground truth is available
        const isLoaded = activeTools.has(toolName);
        if (isLoaded) {
          // Tool IS loaded in current preset, but prompt claims it is disabled
          issues.push({
            ruleId: RULE_IDS.TOOL_PRESET_MISMATCH,
            severity: 'warning',
            line: lineNum,
            message: `Tool "${toolName}" is actively loaded in the current runtime/preset. Stating it is disabled in the prompt conflicts with registered capabilities; disable it in profile cordis.patch.yml instead.`,
            fixable: false
          });
        } else {
          // Tool is NOT loaded in preset; prompt is defensively explaining absence of non-existent tool
          issues.push({
            ruleId: RULE_IDS.TOOL_PRESET_MISMATCH,
            severity: 'warning',
            line: lineNum,
            message: `Tool "${toolName}" is not registered in the current preset/plugins. Describing its absence in the prompt adds redundant attention noise for a non-existent tool.`,
            fixable: true
          });
        }
      } else {
        // Offline check without active tools context: do not make subjective assumptions
        issues.push({
          ruleId: RULE_IDS.UNVERIFIED_TOOL_DISABLEMENT,
          severity: 'info',
          line: lineNum,
          message: `Tool disablement clause detected for "${toolName}". Verify whether this tool is loaded in your active profile preset.`,
          fixable: false
        });
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
          fixable: wm.fixable
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

    // 6. CLI Require Confusion Check
    for (const cliRule of CLI_REQUIRE_PATTERNS) {
      if (cliRule.pattern.test(line)) {
        issues.push({
          ruleId: RULE_IDS.CLI_REQUIRE_CONFUSION,
          severity: 'warning',
          line: lineNum,
          message: `Attempting to require or import external CLI tool directly. ${cliRule.suggestion}.`,
          fixable: false
        });
        cliRule.pattern.lastIndex = 0;
      }
    }
  }

  // Calculate stats
  const chars = content.length;
  const lineCount = lines.length;
  const estimatedTokens = Math.ceil(chars / 3.8);

  // Calculate score (0 - 100)
  // Only errors and warnings deduct points; informative unverified notes do not penalize
  let deductions = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') deductions += 25;
    else if (issue.severity === 'warning') deductions += 10;
    else if (issue.severity === 'info' && issue.ruleId !== RULE_IDS.UNVERIFIED_TOOL_DISABLEMENT) {
      deductions += 4;
    }
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
 * When activeTools is supplied, safely cleans up absent tool disablement clauses.
 * @param {string} content
 * @param {object} [options]
 * @returns {string} Cleaned and optimized prompt text.
 */
export function fixPrompt(content = '', options = {}) {
  if (typeof content !== 'string') return '';

  const activeTools = resolveActiveToolNames(options);
  const lines = content.split('\n');
  let inCodeBlock = false;

  const fixedLines = lines.map((line) => {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;

    let fixedLine = line;

    // 1. Remove obsolete jargon / ralph
    fixedLine = fixedLine.replace(/\s*\(no workflows,\s*ralph(?:,\s*or delegation)?\)/gi, '');
    fixedLine = fixedLine.replace(/\b(?:no workflows,\s*)?ralph(?:,\s*or delegation)?\b/gi, '');

    // 2. Fix weak modals
    fixedLine = fixedLine.replace(/\bBias toward\b/g, 'Prioritize');
    fixedLine = fixedLine.replace(/\bbias toward\b/g, 'prioritize');

    // 3. Clean up tool phrasing if tools are not loaded in preset (or by default cleanup)
    if (!activeTools || !activeTools.has('tool-pwsh')) {
      fixedLine = fixedLine.replace(
        /-\s*Shell:\s*harness\s*`bash`\s*only\s*\(`tool-pwsh`\s*disabled\)\.\s*Launch\s*`pwsh\.exe`\s*from\s*`bash`\s*when\s*needed\./gi,
        '- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.'
      );
    }

    if (!activeTools || (!activeTools.has('web-search-deepseek') && !activeTools.has('tool-web'))) {
      fixedLine = fixedLine.replace(
        /-\s*Web:\s*harness\s*`web-search-deepseek`,\s*`web-fetch-http`,\s*and\s*`tool-web`\s*are\s*disabled\.\s*Research\/fetch\s*STRICTLY\s*via\s*skills\s*\(([^)]+)\)\s*or\s*bash\s*CLIs\./gi,
        '- Web: Research/fetch STRICTLY via skills ($1) or bash CLIs.'
      );
    }

    // 4. Uppercase directive constraints
    for (const dc of DIRECTIVE_CASING) {
      fixedLine = fixedLine.replace(dc.pattern, dc.replacement);
    }

    return fixedLine;
  });

  return fixedLines.join('\n');
}

/**
 * Read and lint a prompt file from disk.
 * @param {string} filePath
 * @param {object} [options]
 * @returns {object|null}
 */
export function lintPromptFile(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      filePath,
      ...lintPrompt(content, options)
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
