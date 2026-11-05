# `dsh-plugin-agent-optimizer` Architecture Plan

## Scope & Exit Criteria

- **Scope**: Build `dsh-plugin-agent-optimizer` as a standalone, non-invasive Cordis plugin around the official `@deepseek-ai/dsh-agent-loop`, separating loop lifecycle ownership from policy guards (`runtimePolicy`, `fileMutationPolicy`, `failureRecovery`), composite tooling (`read_batch`), soft convergence guidance, and objective A/B telemetry (`agentTelemetry`).
- **Exit Criteria**:
  1. `cordis.patch.yml` mounts `dsh-plugin-agent-optimizer` purely additively without disabling `@deepseek-ai/dsh-agent-loop` or mutating `agent/request` parameters.
  2. All runtime policy guards, PTC-backed `read_batch` dispatches, soft-step reminders, and telemetry aggregations pass integration tests against the official loop (`npm test` exits `0`).
  3. Public TypeScript declarations (`src/*.d.ts`, `test/types.ts`) pass strict `tsc --noEmit` verification (`npm run typecheck` exits `0`).

## Architectural Boundaries

1. **Official Loop Ownership**: `@deepseek-ai/dsh-agent-loop` retains 100% control over turn/step state machines, tool concurrency, retries, cancellation, and `agent/request` consistency assertions.
2. **Defensive Runtime Policy (`src/runtime-policy.js`)**: Intercepts consecutive identical tool failures (`NO_PROGRESS`) and oversized Windows shell/inline-script payloads (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`) at `tools/pre-execute`.
3. **File Mutation & Write Recovery (`src/file-mutation-policy.js`, `src/failure-recovery.js`)**: Tracks observed/existing vs newly created files per turn and provides one-shot `retry_failed_write` recovery via `ToolExecutionPipeline`.
4. **Composite Tooling (`src/composite-tools.js`)**: Provides `read_batch` over `ToolExecutionPipeline` to execute multiple independent `read` calls in a single model round-trip while preserving all sandbox and policy hooks.
5. **Soft Convergence Guidance (`src/convergence.js`)**: Injects parallel/batching guidance and a one-time soft step budget notice on `agent/pre-step` without hard-stopping the turn, tracking token overhead in telemetry.
6. **Objective Telemetry (`src/telemetry.js`)**: Measures model requests, tool batching parallelism (`toolCalls / toolBatches`), policy interceptions, token usage, prefix stability, and A/B deltas against baseline runs.
