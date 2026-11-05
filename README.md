# dsh-plugin-agent-optimizer

> Non-invasive runtime policy, PTC-backed composite batch tools, soft convergence guidance, and A/B turn telemetry plugin for the official DeepSeek Harness (`@deepseek-ai/dsh-agent-loop`).

[![Release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-plugin-agent-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-plugin-agent-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-13%20passed-brightgreen.svg)](test)
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
   - Dispatches every sub-read through `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) so all DSH sandbox permissions and policy hooks remain enforced.
6. **Lightweight Soft Convergence (`src/convergence.js`)**:
   - Injects batching/efficiency guidance and a one-time soft step budget notice (`softStepBudget: 8`).
   - **Important**: A soft budget notice appends one user message (`source.kind = "optimizer-convergence"`). It is **not** a hard stop, does not guarantee fewer model requests on its own, and adds a small input token cost tracked by telemetry.
7. **Objective A/B Telemetry (`src/telemetry.js`)**:
   - Tracks `modelRequests`, `toolCalls`, `ptcSubCalls`, `toolBatches`, `parallelismRatio` (`toolCalls / toolBatches`), `failedToolCalls`, `wallClockMs`, `firstTokenMs` (`p50`/`p95`), token usage, and prompt history prefix stability (`prefixChanges`).

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
          maxBatchFiles: 10
        convergence:
          enabled: true
          injectGuidance: true
          softStepBudget: 8
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
