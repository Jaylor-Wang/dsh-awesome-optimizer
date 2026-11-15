# Persistent eval workspace integration

Scope: carry the session working directory in each eval request and synchronize it before user code, including reset and worker recovery. Preload pathlib, difflib, and csv, and remove Python worker traceback frames while preserving user locations and exception chains. Keep the current Node VM capabilities and session/cancellation behavior.

Exit criteria:
- Python and Node eval follow initial and changed session directories without clearing user state; invalid directories prevent user code and reset from executing.
- CWD and the eager Python modules survive namespace reset and worker restart; sessions and queued requests remain isolated.
- Python diagnostics retain eval line numbers, syntax source/carets, library frames, causes, and exception groups without worker implementation frames.
- Relevant tests, the full repository suite, declaration type checking, static diagnostics, and diff checks pass or have explicit evidence for any remaining gap.

Implementation:
1. Add cwd to runner request options and declarations; resolve initial cwd from the workingDirectory service and track session directory events with lifecycle cleanup.
2. Synchronize cwd and CWD inside both workers before reset/eval; add eager Python modules and structured traceback filtering.
3. Update tool/environment descriptions and add focused protocol/integration/diagnostic regression tests.
4. Run verification and review the final diff.

Completed:
- Session cwd is captured per request, validated as an absolute directory, and applied before namespace reset or user code. Session teardown clears cached directories.
- Python preloads the three analysis modules; both workers refresh CWD on every eval/reset. Traceback filtering preserves eval/library frames, syntax details, explicit/implicit causes, and exception groups.
- Regression coverage includes Unicode/space paths, relative i18n file analysis, invalid cwd without state mutation, queue order, session isolation, official agent-loop integration, and cwd recovery after cancellation/watchdog restart.

Verification (Windows, Node.js 24 / Python 3.13):
- Full repository suite: 98/98 passed.
- Final targeted persistent-eval suites after the last type narrowing and added watchdog assertions: 47/47 passed.
- npm run typecheck: passed.
- lsp diagnostics for changed implementation and eval tests: zero errors; Python ty is clean. Existing style/security advisories remain (including intentional exec and exception handling in the eval worker).
- git diff --check: passed.
- Fixed initial Windows test-cleanup failures by destroying workers before asynchronous temporary-directory removal with bounded lock retries.
