/** Choose bounded windows by marginal pattern coverage, then diverse information per line. */
export function selectReadWindows(candidates, { maxFiles, maxWindows, maxReadLines }) {
  const pending = [...candidates];
  const chosen = [];
  const coverage = new Map();
  const files = new Set();
  let lines = 0;
  while (pending.length && chosen.length < maxWindows && lines < maxReadLines) {
    let best;
    for (let index = 0; index < pending.length; index++) {
      const candidate = pending[index];
      if (!files.has(candidate.file) && files.size >= maxFiles) continue;
      const win = fitWindow(candidate, maxReadLines - lines, coverage);
      const patterns = patternsFor(candidate.file, win.matchedLines);
      const gain = [...patterns].filter(pattern => !coverage.has(pattern)).length;
      const value = [...patterns].reduce((sum, pattern) => sum + 1 / (1 + (coverage.get(pattern) ?? 0)), 0);
      const cost = win.end - win.start + 1;
      const score = [gain, value / Math.sqrt(cost), files.has(candidate.file) ? 0 : 1, Math.min(10, win.matchedLines.length) / cost];
      const contender = { index, file: candidate.file, win, patterns, score };
      if (!best || compare(contender, best) < 0) best = contender;
    }
    if (!best) break;
    pending.splice(best.index, 1);
    chosen.push({ file: best.file, win: best.win });
    files.add(best.file);
    lines += best.win.end - best.win.start + 1;
    for (const pattern of best.patterns) coverage.set(pattern, (coverage.get(pattern) ?? 0) + 1);
  }
  return chosen;
}

function compare(a, b) {
  for (let i = 0; i < a.score.length; i++) {
    if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
  }
  const pathA = a.file.sortPath ?? a.file.displayPath;
  const pathB = b.file.sortPath ?? b.file.displayPath;
  return (pathA < pathB ? -1 : pathA > pathB ? 1 : 0) || a.win.start - b.win.start;
}

function patternsFor(file, lines) {
  const patterns = new Set();
  for (const line of lines) for (const pattern of file.linePatterns.get(line) ?? []) patterns.add(pattern);
  return patterns;
}

function fitWindow({ file, win }, remaining, coverage) {
  if (win.end - win.start + 1 <= remaining) return win;
  // A small final line budget must retain the most informative hits, not just the first hit.
  let best;
  for (const line of win.matchedLines) {
    const start = Math.max(win.start, Math.min(line, win.end - remaining + 1));
    const end = start + remaining - 1;
    const matchedLines = win.matchedLines.filter(hit => hit >= start && hit <= end);
    const patterns = patternsFor(file, matchedLines);
    const gain = [...patterns].filter(pattern => !coverage.has(pattern)).length;
    const value = [...patterns].reduce((sum, pattern) => sum + 1 / (1 + (coverage.get(pattern) ?? 0)), 0);
    if (!best || gain > best.gain || (gain === best.gain && value > best.value)) {
      best = { start, end, matchedLines, gain, value };
    }
  }
  return best;
}
