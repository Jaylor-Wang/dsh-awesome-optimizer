# dsh-plugin-agent-optimizer

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-plugin-agent-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-plugin-agent-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-plugin-agent-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-plugin-agent-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-plugin-agent-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-21%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

High-performance, non-invasive runtime policy, PTC-backed composite batch tooling, standalone refined system prompt engine (~80% token savings), and objective A/B turn telemetry plugin for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`).

---

## Highlights in v1.1.0

- **Standalone `SYSTEM.md` Engine & ~80% Token Reduction (`placement: "replace-all"`)**: Completely prunes verbose official prompt sections (~2,000 tokens of duplicate single-tool instructions, Web GUI commands, etc.), allowing a concise, standalone `~/.dsh/SYSTEM.md` (~380 tokens) to govern as the single authority. Saves ~1.6K tokens per turn, significantly reducing multi-turn cost and context drift.
- **Zero-Config by Default**: Built-in defaults activate `replace-all`, millisecond hot-reload, and dual-layer discovery out of the box. No extra configuration lines needed in `cordis.patch.yml`.
- **PTC Native Composite Batch Tooling (`read_batch` / `edit_batch`)**: Read multiple file snippets concurrently in a single tool call, and apply sequential literal text replacements across one or more files in one go—eliminating fragile unified diffs and network round-trip overhead.
- **Windows Hardening & Defensive Recovery**: Intercepts oversized shell commands and multiline inline scripts before Windows `spawn ENAMETOOLONG` occurs; provides single-turn replay recovery (`retry_failed_write`) for unpaired justification errors and hard-stops no-progress failure loops (`NO_PROGRESS`).

---

## Core Features & Architecture

### 1. Refined System Prompt & File-Driven Hot-Reload (`customPrompt`)

- **Standalone Mode (`placement: "replace-all"`)**:
  Hooks into the DSH `system-prompt/assemble` waterfall to strip all official verbose sections (`harness:*`, `deployment:*`, `tool:*`, `deliverable:*`, `web:*`), preserving convergence guidance companion sections while presenting your refined `SYSTEM.md` as the standalone authority (~82% reduction from ~2,000 to ~380 tokens).
- **Dual-Layer Markdown Convention**:
  Automatically discovers global `~/.dsh/SYSTEM.md` (or `$DSH_HOME/SYSTEM.md`) and project workspace `.dsh/SYSTEM.md` (or `SYSTEM.md`), cleanly separating developer system defaults from repo-specific instructions.
- **Millisecond Hot-Reload**:
  Uses debounced `fs.watch` to detect prompt file edits and applies them reactively on the very next turn without restarting the DSH process.
- **Flexible Cascading Strategies**:
  Supports `concat` (cascading global and workspace prompts, default) and `workspace-override` (repo prompt completely replaces global prompt).

| Dimension | Official Default System Prompt | Optimized with This Plugin | Savings |
| :--- | :--- | :--- | :--- |
| **Token Usage** | ~2,000 tokens / turn | **~380 tokens / turn** | **~82% token reduction** |
| **Long Multi-Turn Sessions** | ~100K redundant tokens across 50 turns | Clean, focused, high-density context | **Mitigates context drift & forgetting** |
| **Config Updates** | Requires restart or reload | Instant hot-reload on file save | **Immediate feedback** |

### 2. PTC Native Composite Batch Tooling (`compositeTools`)

- **`read_batch`**:
  Concurrently inspects up to 10 targeted file snippets in a single turn. Ideal for broad multi-file investigation and dependency tracing.
- **`edit_batch`**:
  Sequentially applies up to 10 targeted literal text replacements across single or multiple files in one round trip. Tolerates partial failures without losing preceding valid edits.
- **Inherited Security & Sandboxing**:
  Every sub-action is dispatched through the official `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`), preserving file policy locks, mutation guards, and audit hooks.

### 3. Defensive Runtime Policy & Self-Healing Recovery

- **No-Progress Circuit Breaker (`NO_PROGRESS`)**:
  Computes deterministic tool invocation fingerprints. If an identical failing tool call repeats up to `noProgressLimit` (default `2`), the plugin blocks execution at `tools/pre-execute`, forcing the agent to adapt its diagnostic approach.
- **Windows Oversized Shell Command Interception (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**:
  Automatically blocks commands exceeding `4096` bytes or inline scripts (`node -e`, `python -c`, `pwsh -Command`) exceeding `512` bytes, steering the model to write deliverables to disk first.
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
dsh plugin --profile web add dsh-plugin-agent-optimizer
```

### 2. Via npm / pnpm

```bash
# Using npm
npm install dsh-plugin-agent-optimizer

# Using pnpm
pnpm add dsh-plugin-agent-optimizer
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
<summary>Click to expand production-ready 55-line prompt template (~380 tokens)</summary>

```markdown
# AUTONOMOUS AGENT CORE DIRECTIVE

You are a master autonomous software engineer powered by DeepSeek Harness.
- Bias toward direct action over speculation: investigate via concurrent tools (fs, bash, skills) without orchestration overhead (no workflows, ralph, or delegation).
- Avoid pre-action narration. Deliver surgical edits and high-signal conclusions.
- Irreversible operations (npm publish): STRICTLY conservative and non-autonomous. NEVER bump versions or mutate artifacts to bypass failures; registry validation causes transient 404 or stale views—NEVER treat as failure or retry publish. MUST verify remote state with read-only commands before declaring status.

## Defaults

- Reply in Chinese; code comments and commit messages in English unless requested otherwise. In user-facing text, keep Windows paths as the user wrote them (`E:\...`); use forward slashes or quoted paths only in tool arguments.
- Answer / explain / review / diagnose / plan: inspect and report without edits unless requested otherwise.
- Change / build / fix: make the smallest in-scope edits necessary for the requested task; task authorization includes necessary edits to related files. Keep changes conservative and reversible. Preserve unrelated user work. Do not reset or clean the working tree unless explicitly requested. Do not perform unrelated cleanup, reformatting, dependency changes, or test rewrites. Task-created temporary artifacts may be removed after use. New tests only via Verification.
- Ask first (via `ask_user_question`) only when ambiguity materially affects scope, architecture, or data safety; otherwise execute autonomously.
- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.
- Web: Research/fetch STRICTLY via skills (`agent-reach`, `gh`, `opencli-*`, `smart-search`) or bash CLIs.

## Efficiency

### Hard Constraints

- Retry only when the error or new evidence supports a specific correction; after two failures without progress, switch diagnostic approaches.
- Windows arguments: for complex or multiline payloads (`node -e`, `python -c`, `pwsh -Command`, `playwright-cli eval`, `gh`), bias toward supported stdin or file inputs. Avoid raw multiline arguments through `.cmd`/`.bat` wrappers; single-line payloads still require correct quoting (ast-grep patterns STRICTLY in single quotes `'...'` to avoid `$$` PID expansion). After quoting or argument-parsing failures, switch the input method instead of repeatedly adjusting escapes; diagnose from the actual error, not the exit code alone.
- Byte-fidelity: default new text files to UTF-8. Preserve existing file encodings, BOMs, line endings, `.gitattributes`, and hook policies unless conversion is explicitly requested.
- Policy denials (`file access denied`, network blocked, approval disabled/rejected) are not command bugs: report; do not bypass. Request wider access via `sandbox_permissions` ONLY when escalation is explicitly available; otherwise do not retry or escalate. Diagnose ordinary lock, permission, or connectivity errors normally.
- Text search: NEVER run `grep`/`rg` via `bash` on workspace files; use native `grep`. Filtering command output (`cmd | grep`) is fine.

### Execution & Context Efficiency

- Workflow:
  - Complexity: simple → execute; high-scope (cross-module, API, schema) → generate / follow plan (`<name>.md`); define 1–3 sentence scope and exit criteria before edits.
  - Scheduling: batch independent reads (use `read_batch` for multi-file inspection); keep edits, retries, and dependent checks sequential.
  - Diagnosis: contiguous context in one pass; cite locators and minimal raw excerpts only as evidence.
- Search & navigation:
  - Scope check: verify via `git rev-parse --is-inside-work-tree` when workspace boundary is ambiguous (do not probe `.git`).
  - Code intelligence: bias toward `lsp` CLI (`lsp def`, `lsp ref`, `lsp hover`); outline via `lsp symbols <file>` or `ast-grep outline` before reading large files; `ast-grep` for structural queries (`-p`, `-k`; `ast-grep run` exit 1 means 0 matches, not error; `scan` exits 0 either way).
  - Files & text: native `glob`/`grep` (gitignore-aware by default; pass `gitignore: false` for ignored paths); broad matches → narrow `path`/glob or page via `skip`, NEVER truncate blindly. Use `git` via `bash` only for git-specific facts (tracked status, history, diffs). Probe binary availability via `which`/`command -v`, NEVER scan directory listings.
- Modification & execution:
  - File ops: STRICTLY native `read`/`read_batch`/`edit`/`edit_batch`/`write`; write deliverables directly. Bias toward `edit_batch` for applying targeted replacements across one or more files in a single turn. Bias toward `edit` for single partial modifications; use `write` for new files or necessary full replacements. Unified calc/verification scripts permitted via `write`. NEVER use shell commands or redirects for file ops: `cat`, `type`, `head`, `tail`, `ls`, `dir`, `sed`, `awk`, `find`, `tee`, or `>`/`>>`.
  - Staged refactor: preview, then apply — symbol renames via `lsp rename` (dry-run → `--apply`); structural rewrites via `ast-grep run -p ... -r ...` (then `-U`).
  - Structured data: process STRICTLY via ad-hoc Node/Python scripts passed via stdin or temp files; NEVER dump raw data into context.
  - Shell execution: system binaries, external CLIs, builds, package managers, test runners — STRICTLY via `bash`.
- Reporting: diffs and evidence first; zero filler. Routine status ≤ 300 Chinese characters. Answer/explain/review/diagnose/plan: no length cap. Compact locators, lists, and deltas only.

## Verification

Applies only to change/build/fix.

- NEVER falsify tests (weaken assertions, stub a failing path, or skip a check to pass).
- Choose checks by the highest affected behavioral or contract risk. Prioritize existing relevant checks; add a targeted test when changed behavior lacks coverage. Do not repeat equivalent checks unless code, configuration, environment, or relevant evidence changes:
  - Text or mechanical changes without behavioral or contract effects: inspect the diff and relevant syntax/format; skip unrelated linters.
  - Behavior changes: check static diagnostics via primary tools (e.g. `lsp diag <file|dir> -e`, skip if language unsupported; no redundant CLI linters), then run the smallest non-destructive targeted build/test covering affected behavior and internal interfaces.
  - Shared API, schema, or migration changes: run the full related suite plus project-wide type checking where applicable (e.g. `tsc --noEmit`).
- Report checks, results, and verification gaps; if primary diagnostics are unavailable, use an existing equivalent check when possible.
- Browser checks: STRICTLY `playwright-cli` post-write. NEVER pre-probe, create dummy pages, or switch tools. Reuse app URL (loopback for static); stabilize animations before capture. Batch-cleanup sessions/servers/artifacts without redundant listings. On failure, report root cause.
- Persistent failure: failed command(s), 1–2 sentence root cause, blast radius, next steps.
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
