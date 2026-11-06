# dsh-plugin-agent-optimizer

> Non-invasive runtime policy, PTC-backed composite batch tools, soft convergence guidance, and A/B turn telemetry plugin for the official DeepSeek Harness (`@deepseek-ai/dsh-agent-loop`).

[![Release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-plugin-agent-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-plugin-agent-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-21%20passed-brightgreen.svg)](test)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-red.svg)](README.zh.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Architectural Boundaries

`dsh-plugin-agent-optimizer` strictly separates **loop lifecycle ownership** from **local policy and efficiency optimizations**:

1. **Official Loop Ownership (`@deepseek-ai/dsh-agent-loop`)**:
   - Retains 100% control over turn/step state machines, durable session replay, native parallel tool scheduling (`maxParallelToolCalls`), retries, cancellation, and `end_turn` completion semantics.
   - `cordis.patch.yml` mounts `dsh-plugin-agent-optimizer` purely additively (`- insert:`) and **never disables or replaces** `@deepseek-ai/dsh-agent-loop`.
2. **Never Mutates `agent/request` Parameters**:
   - The official loop verifies that `provider`, `model`, and `reasoningEffort` in `agent/request` match the step's selected configuration. This plugin never hooks `agent/request` to downgrade reasoning effort mid-turn.
3. **Defensive Runtime Policy (`src/runtime-policy.js`)**:
   - **`NO_PROGRESS` Guard**: Computes deterministic tool invocation fingerprints and blocks repeated identical failing tool calls after `noProgressLimit` (default `2`) consecutive failures.
   - **Windows Shell Payload Guard (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**: Blocks `bash` commands exceeding `maxShellCommandBytes` (`4096` bytes) or inline script arguments (`node -e`, `python -c`, `pwsh -Command`) exceeding `maxInlineScriptBytes` (`512` bytes) to prevent `spawn ENAMETOOLONG` on Windows.
4. **File Mutation & Write Recovery (`src/file-mutation-policy.js`, `src/failure-recovery.js`)**:
   - Tracks observed/existing vs. newly created files per turn and guards against accidental large full-file overwrites when `edit` is available.
   - Provides one-shot `retry_failed_write` recovery over `ToolExecutionPipeline` when a large `write` (`8KB–1MB`) is rejected due to an unpaired `justification`, avoiding regenerating the file content.
5. **Composite Batch Tooling (`src/composite-tools.js`)**:
   - Registers `read_batch` to read up to `maxBatchFiles` (`10`) files in a single tool call.
   - Registers `edit_batch` to apply up to `maxBatchEdits` (`10`) targeted literal text replacements across one or multiple files in a single tool call.
   - Dispatches every sub-operation sequentially through `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) so all DSH sandbox permissions, file mutation policies, and observation hooks remain enforced.
   - Tolerates partial failures, returning structured status for each entry rather than aborting valid operations.
6. **Lightweight Soft Convergence (`src/convergence.js`)**:
   - Injects batching/efficiency guidance and periodic micro-directive reminders (`stepInterval: 8`, `maxRemindersPerTurn: 4`).
   - Automatically suppresses reminders when preceding tool calls fail to allow unimpeded debugging.
   - **Important**: Soft reminder notices append a concise micro-directive user message (`source.kind = "optimizer-convergence"`). It is **not** a hard stop, does not guarantee fewer model requests on its own, and adds minimal input tokens tracked by telemetry.
7. **Objective A/B Telemetry (`src/telemetry.js`)**:
   - Tracks `modelRequests`, `toolCalls`, `ptcSubCalls`, `toolBatches`, `parallelismRatio` (`toolCalls / toolBatches`), `failedToolCalls`, `wallClockMs`, `firstTokenMs` (`p50`/`p95`), token usage, and prompt history prefix stability (`prefixChanges`).
8. **Reactive File-Driven System Prompt Customization (`src/custom-prompt.js`)**:
   - **Dual-Layer `SYSTEM.md` Convention**: Automatically discovers global `~/.dsh/SYSTEM.md` (or `$DSH_HOME/SYSTEM.md`) and project-level workspace `.dsh/SYSTEM.md` (or `SYSTEM.md`), cleanly separating developer system defaults from repo-specific instructions and distinct from role-oriented `AGENTS.md`.
   - **Millisecond Hot-Reload**: Powered by debounced `fs.watch` watchers, changes saved in your editor take effect immediately on subsequent turns without restarting the DSH server.
   - **Cascading & Placement Modes**: Configurable merge strategies (`concat` cascading, `workspace-override`, `global-only`, `workspace-only`) and placement targets (`suffix` at order `10300`, `replace-persona-suffix`, or `prefix`).

---

## Configuration (`cordis.patch.yml`)

```yaml
- insert:
    - id: agent-optimizer
      name: dsh-plugin-agent-optimizer
      config:
        enabled: true
        runtimePolicy:
          mode: enforce
          noProgressLimit: 2
          recoveryAttemptLimit: 1
          minLargeWriteBytes: 8192
          maxShellCommandBytes: 4096
          maxInlineScriptBytes: 512
        fileMutationPolicy:
          mode: observe
          minLargeWriteBytes: 8192
        recoverFailedWrites: true
        compositeTools:
          enabled: true
          readBatch: true
          editBatch: true
          maxBatchFiles: 10
          maxBatchEdits: 10
        convergence:
          enabled: true
          injectGuidance: true
          stepInterval: 8
          maxRemindersPerTurn: 4
        customPrompt:
          enabled: true
          globalFile: "~/.dsh/SYSTEM.md"
          workspaceFile: ".dsh/SYSTEM.md"
          placement: "suffix"
          mergeStrategy: "concat"
          hotReload: true
        telemetry:
          enabled: true
          trackStreams: true
```

---

## Verification & A/B Benchmarking

```bash
# Link local peer dependencies from the installed DSH host (zero network requests)
npm run setup:local

# Run integration tests against the official @deepseek-ai/dsh-agent-loop
npm test

# Verify TypeScript declarations
npm run typecheck

# Run offline A/B mechanism verification
npm run benchmark
```
