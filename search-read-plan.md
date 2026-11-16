# Search and Read Hardening Plan

## Scope
Implement complete-output byte budgets, exact regex preservation, and upstream search truncation/recovery reporting for find_and_read. Bound merged windows, total requested read lines, and concurrent read batches; preflight readGuard outline reads through the filesystem service without fallback after service failures. Preserve the existing tool pipeline, unrelated edits, and the current release version.

## Exit criteria
All output paths respect maxTotalBytes with valid Unicode and actionable omission/truncation notices. Read requests obey window/total/concurrency limits and stop scheduling when the output budget is exhausted. Outline inspection skips unsupported/oversized files before content reads, honors cancellation and service access failures, and uses bounded reads when available. Relevant regression tests, the complete test suite, type checks, static diagnostics, and diff checks pass.

## Steps
1. Implement bounded find_and_read output and search provenance. Completed.
2. Bound windows, aggregate read work, and batch scheduling. Completed.
3. Harden readGuard preflight and filesystem failure behavior. Completed.
4. Add regression coverage, verify contracts, and document configuration. Completed.

## Verification
- Full repository suite: 121/121 passed, including 23 new regression tests.
- Existing focused suite before final checks: 12/12 passed.
- New boundary suite before cancellation additions: 21/21 passed; final full suite includes both cancellation regressions.
- npm run typecheck: passed with the new public configuration declarations.
- lsp diagnostics on all four changed implementations and both new test files: zero errors; advisory import/style warnings only.
- git diff --check: passed.
- Hard-budget cases include 512-byte and 24KB limits, Unicode paths/content, first-slice overflow, long indexes, all-error/zero-match paths, partial search failure, and read errors.
- Scheduling checks cover chained dense matches, per-window/total line bounds, concurrency, output-budget exhaustion, native read truncation, and cancellation.
- readGuard checks cover supported-language filtering, preflight sizes/types, bounded byte reads, invalid UTF-8, stream limits/closure, legacy preflight, cancellation, and no local fallback after resolve/stat/read failures.

## P2 scope and exit criteria
Improve window selection by marginal regex coverage and line cost, preserving stable ordering and all P0/P1 limits. Improve lightweight lexical outlines across JS/TS/Python/Go/Rust, including multiline declarations and false declarations inside comments/strings. Cache parsed symbol entries by session/backend/file identity and version within bounded LRU limits; stat remains mandatory, writes invalidate entries, and unversioned files are not cached.

### P2 steps
1. Implement and verify coverage-aware window selection. Completed.
2. Improve lexical scanning and bounded outline selection. Completed.
3. Add version-validated outline caching and regression coverage. Completed.
4. Run full tests, declarations, static diagnostics, and diff checks. Completed.

### P2 verification
- Full repository suite: 139/139 passed, including 18 new P2 tests.
- Final targeted suite after declaration-boundary and cache-initialization corrections: 28/28 passed.
- npm run typecheck: passed with maxCacheEntries/maxCacheBytes declarations and fixtures.
- lsp diagnostics on all six P2 implementation files and all three new test files: zero errors; advisory style diagnostics only.
- git diff --check: passed.
- Ranking checks cover marginal pattern coverage, line-cost penalties, stable ties, file limits, shortened-window coverage, and a real official-loop first-window result.
- Lexical checks cover JS/TS templates, regexes, comments, multiline/generic functions and methods, local arrows, function expressions, Python triple strings and Unicode, Go raw strings/receivers, Rust raw strings/nested comments/lifetimes, incomplete headers, and bounded tail sampling.
- Cache checks cover offset re-filtering, turn reuse, versions/identities/languages/sessions, disabled/unversioned caches, stat denial, mutation/disposal invalidation, version races, in-flight invalidation, and entry/serialized-byte LRU limits.

### P2 limits
- The P2 lexical layer remains a bounded navigation aid, not a complete parser. The subsequent AST stage below adds on-demand structural extraction; macro-generated declarations and unusual syntax may still require manual inspection.
- Cache payload caps measure serialized symbol data, not exact JavaScript heap allocation. Unversioned/local-only backends read without cache; current native services supply identity and version.
- No live-model latency or token-saving percentage is claimed; regression evidence demonstrates first-window coverage and avoided repeated content reads.

## AST outline scope and exit criteria
Add optional on-demand ast-grep structural outlines using only already-authorized source snapshots over stdin. Keep lightweight scanning for ordinary files; support bounded subprocess lifetime/output, cancellation, isolated CLI configuration, lexical fallback on failure, and the existing identity/version LRU for successful and failed attempts. Add a reproducible Windows benchmark reporting first invocation, repeated uncached parse, lexical-only, and version-cache hit timing with process/read counts and correctness assertions. Preserve existing P0/P1/P2 behavior and all unrelated working-tree changes.

### AST steps
1. Implement snapshot-only bounded CLI runner and demand selection. Completed.
2. Integrate parsed AST results with version cache and regression tests. Completed.
3. Measure Windows cold/warm/cache timings and record reproducible results. Completed.
4. Run regression suites, declarations, static diagnostics, and final diff checks. Completed.

### AST verification
- Full repository suite: 147/147 passed, including 8 real-CLI AST tests.
- Final targeted suite after namespace-child preservation: 24/24 passed.
- npm run typecheck: passed with AST mode/command/deadline/output-cap and telemetry declarations.
- lsp diagnostics on AST implementation, readGuard integration, benchmark script, and AST tests: zero errors; advisory style diagnostics only.
- npm pack --dry-run --json: passed; confirmed isolation YAML, runtime module, and benchmark script are included. Benchmark report and JSON are also listed for packaging.
- git diff --check: passed.
- Tests cover snapshot stdin and nonexistent local paths, one-based lines and class members, all five language families, JSX fake-declaration removal, namespace-child preservation, automatic selection/off mode, missing executable, real timeout, real output overflow, cancellation, malformed output, version-cached AST success/fallback, and version invalidation.
- Windows report: outline-benchmark.windows.json and outline-benchmark.md. 20 repeated samples per path; small AST first invocation 67.468ms, repeated uncached median 51.269ms/p95 56.480ms, cached median 0.009ms/p95 0.019ms. Large 142112-byte snapshot initial 58.648ms, cached median 0.055ms/p95 0.068ms. Cached runs assert one content read/one CLI launch across 21 calls.
- Measurement uses a versioned in-memory fs to isolate CLI/parse/render cost. First invocation is process-cold, not a flushed OS cache. No real-model or network speedup is claimed.
- Default auto mode remains lexical for ordinary files; known lexical gaps launch a bounded CLI. Failures fall back and are cached per file version. No target path is passed to the CLI, no shell is used, and the plugin's isolated config ignores custom language libraries.
- Bundled ast-grep namespace extraction lacks child declarations; lexical child entries are retained within AST-confirmed namespace ranges and documented as a hybrid result.

## Cache lifecycle and hit-rate scope
Fix readGuard cleanup using the official session/disposed event, release retained cache references and statistics, and reject late work after session/plugin disposal. Add per-turn cache lookup, miss, bypass, and mutation-invalidation counters with an explicitly defined hit ratio and expose detached readGuard snapshots in unified telemetry. Preserve cache isolation, version checks, read output, and conservative mutation invalidation.

### Exit criteria
Official-loop disposal releases cached outlines, including in-flight inspections, without affecting other sessions. Hit-rate denominators exclude disabled/unversioned caches and failed preflights; zero lookups yield null. Regression tests cover lifecycle races, per-turn reuse, telemetry snapshots, and public declarations. Full related tests, project type checking, static diagnostics, and diff checks pass.

### Steps
1. Correct lifecycle cleanup and define cache accounting. Completed.
2. Integrate telemetry, declarations, and bilingual documentation. Completed.
3. Verify lifecycle races, accounting boundaries, and complete regression checks. Completed.

### Verification
- Full repository suite: 155/155 passed, 4 suites, including 8 new lifecycle/accounting/integration tests.
- Initial targeted suite: 33/33 passed before final multi-backend and standalone-local coverage.
- npm run typecheck: passed after correcting the nullable telemetry type fixture.
- lsp diagnostics: zero errors for readGuard, telemetry, cache/lifecycle/boundary tests, and the public type fixture; advisory import/style diagnostics only.
- git diff --check: passed.
- Official-loop integration verifies independent per-turn snapshots, cross-turn cache reuse (50% first turn, 100% second turn), stable message prefixes, and actual session disposal releasing cached payloads without a second clear at plugin disposal.
- Lifecycle tests verify multi-backend release, other-session isolation, repeated disposal, plugin cleanup, late-call rejection, and disposal during stat/content awaits. Counters cover enabled hits/misses, version changes, disabled/unversioned/unidentified/local bypasses, rejected preflights, failed content reads, mutation invalidations, and caller snapshot isolation.

## Compatibility and limits
- Default maxWindowLines=120, maxReadLines=600, readConcurrency=3; maxTotalBytes remains 24576.
- Limits cover requested read lines and the complete returned text, not a fixed filesystem byte count or token count. An already-dispatched batch may complete after the output budget is consumed.
- The supported native fs service provides bounded readBytes. Legacy readText-only services are preflighted, but file growth between stat and read can still cause an over-limit allocation before the returned content is rejected.
- Implementation verification completed before release work. The user subsequently authorized version 3.2.0, commit/push, and a GitHub Release; release metadata and bilingual highlights were updated, and npm pack --dry-run --json verified version 3.2.0 with 47 package entries. The pre-existing deletion of 优化计划.md remains excluded from the release commit.
