/** Choose bounded windows by pattern coverage, then prefer exact-name function declarations. */
export function selectReadWindows(candidates, limits) {
  const declarations = indexDeclarations(candidates);
  const chosen = selectPlan(candidates, limits, new Map());
  if (!declarations.size) return chosen;
  const coverage = planCoverage(chosen, declarations);
  if (coverage.names.size === coverage.patterns.size) return chosen;
  // Try trading references for declarations, but keep every pattern covered by the original plan.
  let best = chosen;
  let bestNames = coverage.names.size;
  for (const declarationWeight of [0, 1]) {
    const alternative = selectPlan(candidates, limits, declarations, declarationWeight);
    const other = planCoverage(alternative, declarations);
    if (other.names.size <= bestNames || ![...coverage.patterns].every(pattern => other.patterns.has(pattern))) continue;
    best = alternative;
    bestNames = other.names.size;
  }
  return best;
}

function selectPlan(candidates, limits, declarations, declarationWeight = 0) {
  const chosen = selectGreedy(candidates, limits, declarations, declarationWeight);
  if (limits.maxFiles !== 1 || limits.maxWindows < 2 || chosen.length === 0) return chosen;

  // Committing the only file slot on the first window can hide a better plan.
  const byFile = new Map();
  for (const candidate of candidates) {
    if (!byFile.has(candidate.file)) byFile.set(candidate.file, []);
    byFile.get(candidate.file).push(candidate);
  }
  let best = chosen;
  let bestCoverage = planScore(best, declarations);
  const sortedFiles = [...byFile.keys()].sort(comparePaths);
  for (const file of sortedFiles) {
    if (file === chosen[0].file) continue;
    const windows = byFile.get(file);
    const upperBound = file.patterns?.size ?? planScore(windows, declarations)[0];
    if (upperBound < bestCoverage[0] || (upperBound === bestCoverage[0] && !declarations.has(file))) continue;
    const plan = selectGreedy(windows, limits, declarations, declarationWeight);
    const coverage = planScore(plan, declarations);
    if (compareScores(coverage, bestCoverage) < 0) {
      best = plan;
      bestCoverage = coverage;
    }
  }
  return best;
}

function indexDeclarations(candidates) {
  const index = new Map();
  for (const file of new Set(candidates.map(candidate => candidate.file))) {
    if (!/\.[cm]?[jt]sx?$/i.test(file.displayPath) || /\.d\.[cm]?ts$/i.test(file.displayPath)) continue;
    for (const [line, patterns] of file.linePatterns) {
      const text = file.lines?.get(line);
      if (!text) continue;
      // A lexical hint, not a parser: only same-line named functions and exact query names.
      const name = text.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s*\*\s*|\s+)([A-Za-z_][A-Za-z_0-9]*)\s*(?=\(|<)/)?.[1];
      if (!patterns.has(name)) continue;
      if (!index.has(file)) index.set(file, new Map());
      index.get(file).set(line, name);
    }
  }
  return index;
}

function declarationsFor(byLine, lines) {
  if (!byLine) return [];
  const names = new Set();
  for (const line of lines) {
    const name = byLine.get(line);
    if (name !== undefined) names.add(name);
  }
  return names;
}

function planCoverage(tasks, declarations) {
  const patterns = new Set();
  const names = new Set();
  for (const { file, win } of tasks) {
    for (const pattern of patternsFor(file, win.matchedLines)) patterns.add(pattern);
    for (const name of declarationsFor(declarations.get(file), win.matchedLines)) names.add(name);
  }
  return { patterns, names };
}

function planScore(tasks, declarations) {
  const { patterns, names } = planCoverage(tasks, declarations);
  return [patterns.size, names.size];
}

function selectGreedy(candidates, { maxFiles, maxWindows, maxReadLines }, declarations, declarationWeight) {
  const pending = [...candidates];
  const chosen = [];
  const coverage = new Map();
  const shownDeclarations = new Set();
  const files = new Set();
  let lines = 0;
  while (pending.length && chosen.length < maxWindows && lines < maxReadLines) {
    let best;
    for (let index = 0; index < pending.length; index++) {
      const candidate = pending[index];
      if (!files.has(candidate.file) && files.size >= maxFiles) continue;
      const byLine = declarations.get(candidate.file);
      const win = fitWindow(candidate, maxReadLines - lines, coverage, byLine, shownDeclarations);
      const patterns = patternsFor(candidate.file, win.matchedLines);
      const names = declarationsFor(byLine, win.matchedLines);
      const [gain, declarationGain, value] = evidenceScore(patterns, names, coverage, shownDeclarations);
      const cost = win.end - win.start + 1;
      const score = [gain + declarationGain * declarationWeight, declarationGain, value / Math.sqrt(cost), files.has(candidate.file) ? 0 : 1, Math.min(10, win.matchedLines.length) / cost];
      const contender = { index, file: candidate.file, win, patterns, names, score };
      if (!best || compare(contender, best) < 0) best = contender;
    }
    if (!best) break;
    pending.splice(best.index, 1);
    chosen.push({ file: best.file, win: best.win });
    files.add(best.file);
    lines += best.win.end - best.win.start + 1;
    for (const pattern of best.patterns) coverage.set(pattern, (coverage.get(pattern) ?? 0) + 1);
    for (const name of best.names) shownDeclarations.add(name);
  }
  return chosen;
}

function evidenceScore(patterns, names, coverage, shownDeclarations) {
  const gain = [...patterns].filter(pattern => !coverage.has(pattern)).length;
  const declarationGain = [...names].filter(name => !shownDeclarations.has(name)).length;
  const value = [...patterns].reduce((sum, pattern) => sum + 1 / (1 + (coverage.get(pattern) ?? 0)), 0);
  return [gain, declarationGain, value];
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function compare(a, b) {
  return compareScores(a.score, b.score) || comparePaths(a.file, b.file) || a.win.start - b.win.start;
}

function comparePaths(a, b) {
  const pathA = a.sortPath ?? a.displayPath;
  const pathB = b.sortPath ?? b.displayPath;
  return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
}

function patternsFor(file, lines) {
  const patterns = new Set();
  for (const line of lines) for (const pattern of file.linePatterns.get(line) ?? []) patterns.add(pattern);
  return patterns;
}

function fitWindow({ file, win }, remaining, coverage, byLine, shownDeclarations) {
  if (win.end - win.start + 1 <= remaining) return win;
  // A small final line budget must retain the most informative hits, not just the first hit.
  let best;
  for (const line of win.matchedLines) {
    const start = Math.max(win.start, Math.min(line, win.end - remaining + 1));
    const end = start + remaining - 1;
    const matchedLines = win.matchedLines.filter(hit => hit >= start && hit <= end);
    const score = evidenceScore(patternsFor(file, matchedLines), declarationsFor(byLine, matchedLines), coverage, shownDeclarations);
    if (!best || compareScores(score, best.score) < 0) {
      best = { start, end, matchedLines, score };
    }
  }
  return best;
}
