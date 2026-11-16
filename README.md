# dsh-awesome-optimizer

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-awesome-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-awesome-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-awesome-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-awesome-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-awesome-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-160%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

High-performance runtime policy guards, persistent Python & Node evaluation daemons, PTC-backed composite batch tooling, standalone refined system prompt engine, and objective A/B turn telemetry plugin for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`).

---

## Highlights in v3.3.0

- **Opt-in HTTP cache diagnostics**: [Capture request hashes and upstream usage](cache-diagnostics.md) for OpenAI-compatible `/chat/completions` to compare message prefixes and configuration across turns. Missing cache counters remain distinct from explicit zero; prompts, responses, image bytes, and credentials are never logged.
- **Bounded, isolated diagnostics**: Asynchronous logging has file and queue limits, flushes on disposal, and stops with one warning on failure. Initialization failures preserve telemetry; response URL, redirect/type metadata, and clone metadata are preserved.
- **Accurate prefix telemetry**: Detects message replacement, in-place mutation, and changes across turns without stale object-identity digest caching.
- **Stricter batch preflight**: Rejects empty or unchanged replacement strings before dispatching edits, keeping atomic preflight consistent with native edit validation.
- **Verification**: 160 tests passed; public declaration type checking passed. No new package dependencies.

---

## Core Features & Architecture

### 1. Refined System Prompt & File-Driven Hot-Reload (`customPrompt`)

- **Standalone Mode (`placement: "replace-all"`)**:
  Hooks into the DSH `system-prompt/assemble` waterfall to strip all official verbose sections (`harness:*`, `deployment:*`, `tool:*`, `deliverable:*`, `web:*`), preserving convergence guidance companion sections while presenting your refined `SYSTEM.md` as the standalone authority.
- **Dual-Layer Markdown Convention**:
  Automatically discovers global `~/.dsh/SYSTEM.md` (or `$DSH_HOME/SYSTEM.md`) and project workspace `.dsh/SYSTEM.md` (or `SYSTEM.md`), cleanly separating developer system defaults from repo-specific instructions.
- **Millisecond Hot-Reload**:
  Uses debounced `fs.watch` to detect prompt file edits and applies them reactively on the very next turn without restarting the DSH process.
- **Flexible Cascading Strategies**:
  Supports `concat` (cascading global and workspace prompts, default) and `workspace-override` (repo prompt completely replaces global prompt).
- **Built-in Prompt Linter & Auto-Fixer**:
  Provides `lintPrompt` / `fixPrompt` / `lintPromptFile` APIs with **preset-aware dynamic tool validation**. Eliminates subjective tool assumptions by verifying tool directives directly against active plugins: flags redundant defensive clauses for unloaded tools or conflicts with actively loaded tools, checks weak modals (e.g. upgrading soft wording to direct imperatives), unclosed backticks, and enforces RFC 2119 uppercase constraints with actionable health scoring (0-100).

| Dimension | Official Default System Prompt | Optimized with This Plugin | Savings |
| :--- | :--- | :--- | :--- |
| **Prompt Context Footprint** | ~2,000 tokens / turn | **~380 tokens / turn (Template)** | **Frees context headroom; eliminates redundant rules** |
| **Long Multi-Turn Sessions** | ~100K redundant tokens across 50 turns | Clean, focused, high-density context | **Mitigates context drift & forgetting** |
| **Config Updates** | Requires restart or reload | Instant hot-reload on file save | **Immediate feedback** |

### 2. PTC Native Composite Batch Tooling (`compositeTools`)

- **`find_and_read`**:
  Searches 1–5 regex patterns in parallel without changing regex whitespace, merges and splits adjacent matches, and dispatches budget-aware batches of native `read` calls in one round-trip. The complete returned text, including headers, errors, indexes, and omission notices, fits `maxTotalBytes` (24KB by default). Matched rows take priority; undisplayed locations become bounded indexes with explicit omission counts. Upstream truncation, failed patterns, totals, and recovery locators that fit are reported.
  - `maxWindowLines: 120`: maximum requested lines per slice, preventing dense chained matches from becoming whole-file reads.
  - `maxReadLines: 600`: maximum total requested lines across all files and windows in one call.
  - `readConcurrency: 3`: maximum simultaneous reads per batch; remaining output space is checked before the next batch. Matches hidden by native read truncation remain in the recovery index.
  - Windows prioritize uncovered regex patterns, then diminishing returns for repeated patterns, line cost, and file diversity. Canonical paths and line numbers break ties deterministically. `maxFiles` bounds selected files without excluding valuable windows in other files before ranking.
  - These bounds cover requested lines and returned bytes, not a fixed number of filesystem bytes or tokens.
- **`readGuard` inspection preflight**:
  Only supported outline languages trigger extra inspection. The fs service resolves and stats the target before reading, preferring bounded `readBytes` or text streaming. Oversized files (`maxInspectBytes`, default 512KB), cancellation, absent files, and service denials skip the outline while preserving the native read result. Service failures never fall back to local disk. Older readText-only services are supported after size preflight, subject to file-growth races between stat and read.
  - Default `astOutline: "auto"` keeps ordinary files on the lexical path and invokes ast-grep on demand for JSX/TSX, TS decorators/exported namespaces, or declaration-like files with empty lexical results. Set `"off"` to disable or `"always"` to force AST for supported languages. Both levels prioritize top-level exports and sample across the unread tail.
  - The CLI receives only the fs-authorized snapshot on stdin, never the target path. It uses fixed plugin configuration, disables custom language libraries, and runs without a shell. Defaults `astTimeoutMs: 750` and `astMaxOutputBytes: 262144` bound time/output. Cancellation terminates the child; missing CLI, timeout, and errors fall back to lexical results. `astGrepCommand` accepts an executable name or absolute path; the CLI must support `outline --stdin --json`.
  - Current bundled ast-grep rules expose TS namespaces without children; lexical child declarations inside AST-confirmed namespace ranges are retained for navigation. AST successes and lexical fallbacks share the version LRU, preventing repeated launches for the same cached file version. Version changes, mutations, or eviction permit another attempt. Inspect `astAttempts/astSucceeded/astFallbacks/astTimeouts/outlineCacheHits` counters.
  - Run `npm run benchmark:outline -- outline-benchmark.windows.json` for real-CLI first-invocation, repeated uncached, lexical, and version-cache timings with 20 repeated samples. See `outline-benchmark.md` for methodology and local Windows results.
  - Parsed-symbol caches are isolated by session, fs backend, resolved identity, language, and version. Every lookup still stats the file; misses validate the version again after reading. Defaults: `maxCacheEntries: 32`, `maxCacheBytes: 262144`. Cached entries are filtered for the current truncation offset. Unversioned targets are not cached; mutation/code-execution tools and session disposal clear the cache. Set `maxCacheEntries: 0` to disable it. The byte cap measures serialized payload, not JS heap usage.
  - The official standalone `session/disposed` event releases that session's backend caches, retained references, and statistics. Plugin disposal clears remaining caches. Inspections in flight cannot repopulate caches or inject late outlines after disposal; other sessions remain isolated.
  - `getStats(session)` returns a detached per-turn snapshot, also exposed as telemetry `summary.readGuard` (`null` when disabled). `outlineCacheLookups = outlineCacheHits + outlineCacheMisses`; `outlineCacheHitRate = hits / lookups` is in [0, 1], or `null` without lookups. Only enabled caches with valid identity/version after successful preflight count as lookups. Absent, stale, or evicted entries count as misses even if the subsequent read or parse fails. Disabled, unidentified, unversioned, and standalone local backends count as `outlineCacheBypasses`; rejected preflights count as neither. Ordinary and targeted reads do not inflate the lookup denominator.
  - `outlineCacheInvalidations` counts mutation/bash/eval events that clear an existing session cache group, including in-flight inspections. No group means no invalidation; version mismatches count as misses, and disposal cleanup does not count as invalidation. Counters reset on `turn/start` while caches survive turns. These metrics describe local outline caching separately from provider input caching.
- **`edit_batch`**:
  Sequentially applies up to 10 targeted literal text replacements across single or multiple files in one round trip, with pre-flight same-file simulation, `atomic` abort support, and automatic line-numbered recovery hints on mismatch.
- **Inherited Security & Sandboxing**:
  Every sub-action is dispatched through the official `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`), preserving file policy locks, mutation guards, and audit hooks.
### 3. Defensive Runtime Policy & Self-Healing Recovery

- **No-Progress Circuit Breaker (`NO_PROGRESS`)**:
  Computes deterministic tool invocation fingerprints. If an identical failing tool call repeats up to `noProgressLimit` (default `2`), the plugin blocks execution at `tools/pre-execute`, forcing the agent to adapt its diagnostic approach.
- **Windows Oversized Shell Command Interception (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**:
  Automatically blocks commands exceeding `4096` bytes or inline scripts (`node -e`, `python -c`, `pwsh -Command`) exceeding `512` bytes, steering the model to write deliverables to disk first.
- **Windows Chained Heavy Task Guard (`CHAINED_HEAVY_COMMAND`)**:
  Intercepts compound shell commands that chain heavy concurrent or publishing tasks (`npm test`, `npm run build`, `vitest`, `npm publish`) with other operations during `tools/pre-execute`. Enforces clean two-tier execution: heavy tasks isolated standalone to prevent Windows process handle hanging and deadlocks, while lightweight Git workflows chain via `&&` for zero-RTT speed.
- **Playwright File Protocol Guard (`PLAYWRIGHT_FILE_PROTOCOL_BLOCKED`)**:
  Pre-execution guard against `playwright-cli open/goto file://...` commands, steering models toward local HTTP loopback servers to prevent protocol errors and orphaned browser processes.
- **Full Overwrite Protection & Single-Shot Recovery (`failureRecovery`)**:
  Prevents accidental destructive `write` overwrites on existing large files when `edit` is available. Automatically registers `retry_failed_write` when a large write (8KB–1MB) is rejected due to an unpaired justification, avoiding costly regeneration.

### 4. Lightweight Convergence & Objective A/B Telemetry

- **Micro-Directive Convergence (`convergence`)**:
  Appends soft guidance notices when steps approach budget intervals (default `stepInterval: 8`, max `4` per turn). Features **error-aware suppression**: automatically silences notices during debugging so trouble resolution remains uninterrupted.
- **Objective A/B Telemetry (`telemetry`)**:
  Collects granular operational metrics including model requests, tool calls, composite parallelism ratio (`parallelismRatio`), time-to-first-token (TTFT), token consumption, and prefix cache stability (`prefixChanges`).

---

## Installation & Quickstart

### 1. Via DSH Plugin Command (Recommended)

```bash
# Add directly to the active web profile
dsh plugin --profile web add dsh-awesome-optimizer
```

### 2. Via npm / pnpm

```bash
# Using npm
npm install dsh-awesome-optimizer

# Using pnpm
pnpm add dsh-awesome-optimizer
```

### 3. Zero-Config Out of the Box

All optimizations are enabled by default upon installation. **No extra lines are required in your global `cordis.patch.yml`**.

#### Optional Advanced Overrides / Disabling
Only when customizing paths or disabling specific subsystems do you need to add an entry in `cordis.patch.yml`:

```yaml
# Example: Only declare overrides when customizing defaults
- id: agent-optimizer
  config:
    # Disable prompt takeover to revert to official verbose prompt
    customPrompt:
      enabled: false

    # Or adjust batch limits
    compositeTools:
      maxBatchFiles: 15
      maxBatchEdits: 15

    # Or relax the no-progress circuit breaker
    runtimePolicy:
      noProgressLimit: 3
```

---

## Production-Ready SYSTEM.md Recommendation

With `placement: "replace-all"`, place your directives in `~/.dsh/SYSTEM.md` (Windows: `C:\Users\<Username>\.dsh\SYSTEM.md`):

<details>
<summary>Click to expand production-ready universal prompt template (50 lines, native tools only)</summary>

```markdown
# AUTONOMOUS AGENT CORE DIRECTIVE

You are a master autonomous software engineer powered by DeepSeek Harness.

- MUST act directly rather than speculate: investigate via concurrent tools (fs, bash, skills) without orchestration overhead.
- NEVER emit pre-action narration. Deliver surgical edits and high-signal conclusions.
- Irreversible operations (`npm publish`): STRICTLY conservative and non-autonomous. NEVER bump versions or mutate artifacts to bypass failures; registry validation causes transient 404 or stale views—NEVER treat as failure or retry publish. MUST verify remote state with read-only commands before declaring status.

## Defaults

- Reply in Chinese; code comments and commit messages in English unless requested otherwise. In user-facing text, preserve Windows path formats as written (`E:\...`).
- Answer / explain / review / diagnose / plan: inspect and report without edits unless requested otherwise.
- Change / build / fix: make the smallest in-scope edits necessary for the requested task; task authorization includes necessary edits to related files. Keep changes conservative and reversible. Preserve unrelated user work. Do not reset or clean the working tree unless explicitly requested. Do not perform unrelated cleanup, reformatting, dependency changes, or test rewrites. Task-created temporary artifacts may be removed after use. New tests ONLY via Verification.
- Ask first (via `ask_user_question`) ONLY when ambiguity materially affects scope, architecture, or data safety; otherwise execute autonomously.
- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.
- Web: Research/fetch STRICTLY via skills (`agent-reach`, `gh`, `opencli-*`, `smart-search`) or bash CLIs.
- Tool boundaries: External tools (playwright-cli, gh, ast-grep) are standalone CLIs via `bash`, NEVER require/import as node modules.

## Efficiency

### Hard Constraints

- Retry ONLY when the error or new evidence supports a specific correction; after two failures without progress, switch diagnostic approaches.
- Windows arguments & paths: use forward slashes in paths to prevent escape corruption. NEVER embed scripts or multiline code in shell arguments (`node -e`, `python -c`, `pwsh -Command`). Quote single-line patterns carefully (`ast-grep` patterns STRICTLY in single quotes `'...'` to prevent `$$` expansion). On quoting failures, switch input method rather than re-escaping.
- Byte-fidelity: default new text files to UTF-8. Preserve existing file encodings, BOMs, line endings, `.gitattributes`, and hook policies unless explicitly requested.
- Policy denials (`file access denied`, network blocked, approval disabled/rejected) are not command bugs: report; do not bypass. Request wider access via `sandbox_permissions` ONLY when escalation is explicitly available; otherwise do not retry or escalate. Diagnose ordinary lock, permission, or connectivity errors normally.
- Tool exclusivity: STRICTLY native `glob`/`grep`/`find_and_read`/`read`/`edit_batch`/`edit`/`write`. NEVER use shell commands or redirects for workspace search or reading/writing files (`grep`, `rg`, `find`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `sed`, `awk`, `tee`, `>`/`>>`). Filtering piped command output (`cmd | grep`) and batch removing temporary artifacts (`rm -rf`) are permitted.

### Execution & Context Efficiency

- Workflow:
  - Complexity: simple → execute; high-scope (cross-module, API, schema) → generate / follow plan (`<name>.md`); define 1–3 sentence scope and exit criteria before edits.
  - Scheduling: Use `find_and_read` when searching code and inspecting surrounding lines together; batch independent `read` calls directly in parallel when exact files/ranges are known. Keep retries and dependent checks sequential.
  - Diagnosis: inspect contiguous context in one pass; cite locators and minimal raw excerpts only as evidence.
- Search & navigation:
  - Scope & environment: verify via `git rev-parse --is-inside-work-tree` when workspace boundary is ambiguous (do not probe `.git`). Probe binary availability via `which`/`command -v` ONLY when execution fails.
  - Runtime context: `pwd`/runtime cwd defines the workspace; the DSH implementation checkout is ONLY for inspecting/extending DSH—NEVER infer cwd from it or edit it unless explicitly requested.
  - Code intelligence: prioritize `lsp` CLI (`lsp def`, `lsp ref`, `lsp hover`); outline via `lsp symbols <file>` or `ast-grep outline` before reading large files; `ast-grep` for structural queries (`-p`, `-k`; `ast-grep run` exit 1 means 0 matches, not error; `scan` exits 0 either way).
  - Files & text: native `glob`/`grep` (gitignore-aware by default; pass `gitignore: false` for ignored paths); broad matches → narrow `path`/glob or page via `skip`, NEVER truncate blindly. Use `git` via `bash` ONLY for git-specific facts (tracked status, history, diffs).
- Modification & execution:
  - File ops: MUST use `edit_batch` for 2+ edits (whether in one file or across multiple files); use `edit` for a single edit, and `write` for new files or ad-hoc Node/Python scripts.
  - Staged refactor: preview, then apply — symbol renames via `lsp rename` (dry-run → `--apply`); structural rewrites via `ast-grep run -p ... -r ...` (then `-U`).
  - Structured data & calculations: Prioritize persistent kernels (`eval_python`/`eval_node`, key stdlib pre-imported) for stateful or exploratory work; return compact summaries, never raw dumps. Deliverables/pipelines: `write` to disk, run by path; never inline code.
  - Shell execution: run heavy tasks (`npm test`, `npm run build`, `vitest`, `npm publish`) standalone to prevent Windows deadlocks; chain lightweight commands via `&&` (`git add ... && git commit ... && git push`) to eliminate round trips.
- Reporting: diffs and evidence first; zero filler. Routine status ≤ 300 Chinese characters. Answer/explain/review/diagnose/plan: no length cap. Compact locators, lists, and deltas only.

## Verification

Applies ONLY to change/build/fix.

- NEVER falsify tests (weaken assertions, stub a failing path, or skip a check to pass).
- Choose checks by the highest affected behavioral or contract risk. Prioritize existing relevant checks; add a targeted test when changed behavior lacks coverage. Do not repeat equivalent checks unless code, configuration, environment, or relevant evidence changes:
  - Text or mechanical changes without behavioral or contract effects: inspect the diff and relevant syntax/format; skip unrelated linters.
  - Behavior changes: check static diagnostics via primary tools (e.g. `lsp diag <file|dir> -e`, skip if language unsupported; no redundant CLI linters), then run the smallest non-destructive targeted build/test covering affected behavior and internal interfaces.
  - Shared API, schema, or migration changes: run the full related suite plus project-wide type checking where applicable (e.g. `tsc --noEmit`).
- Report checks, results, and verification gaps; if primary diagnostics are unavailable, use an existing equivalent check when possible.
- Browser checks: STRICTLY `playwright-cli` post-write. Playwright CLI blocks `file:` URLs—serve static HTML via loopback HTTP (`http://127.0.0.1:<port>`). `screenshot` takes selector target ONLY (no output filename; auto-saved to .playwright-cli/). NEVER pre-probe (`--help`, `--version`, `node -v`), create dummy pages, or switch tools. Reuse runtime Web GUI or active app URL (loopback for static); stabilize animations before capture. Batch-cleanup sessions/servers/artifacts without redundant listings. On failure, report root cause.
- Persistent failure: report failed command(s), 1–2 sentence root cause, blast radius, next steps.
```
</details>

---

## Verification & Benchmarking

```bash
# Link local peer dependencies from installed DSH host (zero network requests)
npm run setup:local

# Run integration tests against official @deepseek-ai/dsh-agent-loop
npm test

# Run strict TypeScript declaration check
npm run typecheck

# Run offline A/B benchmark verification
npm run benchmark
```

---

## Architectural Principles & Safety

1. **Official Loop Ownership (`@deepseek-ai/dsh-agent-loop`)**:
   Turn state machines, native parallel scheduling (`maxParallelToolCalls`), retries, and cancellation semantics remain fully owned by the official loop. This plugin purely mounts additively via Cordis and **never replaces or tampers with** `@deepseek-ai/dsh-agent-loop`.
2. **Zero Model Parameter Mutation**:
   The plugin never hooks `agent/request` to modify model identities, providers, or reasoning efforts.
3. **Transparent Pipeline Security**:
   All composite operations are audited and dispatched individually through the official ToolExecutionPipeline.

---

## License

[MIT](LICENSE) © [Jaylor-Wang](https://github.com/Jaylor-Wang)
