# dsh-awesome-optimizer

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-awesome-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-awesome-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-awesome-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-awesome-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-awesome-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-31%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

围绕官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`) 打造的高性能运行时策略防护、PTC 复合批处理工具、全新独立系统提示词接管与客观 A/B 轮次度量插件。

---

## v1.8.0 版本重要更新

- **解除宿主要求限制（显示为「未声明宿主要求」）**：完全对齐 `dsh-tool-antigravity` 规范，移除了 `package.json` 中的 `engines.dsh` 并将所有 `@deepseek-ai/*` 宿主依赖收拢至开发时依赖（`devDependencies`），彻底消除了插件市场中计算生成的 `DSH >=0.2.2-rc.1 ∩ *` 约束标签，展示为纯净的「未声明宿主要求」，允许在任意 DSH 运行时环境下无阻碍安装与更新。
- **测试运行器 Windows 管道死锁根治**：将测试脚本重构为 `node --test --test-concurrency=1 --test-timeout=10000`，由多 Worker 并发争用改为确定性单通道顺序执行，彻底消除 Windows 控制台 stdio 管道缓冲区互锁与未回收 EOF 挂起隐患。
- **重型任务复合命令链隔离拦截 (`CHAINED_HEAVY_COMMAND`)**：在 `tools/pre-execute` 阶段主动检测并拦截复合链（`&&`、`;`）中的重型构建、测试与发布命令（`npm test`、`npm run build`、`vitest`、`npm publish`），彻底杜绝 Windows 控制台管道死锁；同时放行纯净的 Git 流水线串联（`git add ... && git commit ... && git push`）。
- **临时脚本落地磁盘硬约束升维 (`MUST`)**：将数学建模、复杂计算与辅助脚本的磁盘落地要求全面升级为最高级 RFC 2119 规范 `MUST write ad-hoc Node/Python scripts to disk`，并与 `NEVER embed multiline scripts` 形成工整对仗。
- **Playwright CLI 选择器语义与探测硬约束加固**：明确 `screenshot` 仅接收 CSS 选择器且自动落盘（无输出文件名参数），配合 `--help` / `--version` 探针硬性禁令，消除多余回合损耗与选择器报错。
- **提示词信噪比深度净化与冲突消除**：移除与辅助脚本产生认知对抗的 `produce deliverables directly` 语句；净化 `Windows arguments & paths` 使其 100% 聚焦于引号与转义防坑；去重冗余的 `rm -rf` 清理描述。
- **生态与插件市场表述全量对齐**：全面对齐 DSH 官方插件市场卡片规范，采用标准工业级特性命名 `SYSTEM.md replacement mode`，去除生僻术语。

---

## 核心特性与架构设计

### 1. 系统提示词精简与文件驱动热重载 (`customPrompt`)

- **独立接管模式 (`placement: "replace-all"`)**：
  在 DSH 官方 `system-prompt/assemble` 组装瀑布流中，精确剥除官方 verbose 冗余章节（包括 `harness:*`、`deployment:*`、`tool:*`、`deliverable:*`、`web:*` 等），并保留会话收敛指导等协同章节，将系统提示词基线精简至约 380 tokens 的轻量核心指令。
- **双层 Markdown 规约**：
  自动寻找全局配置 `~/.dsh/SYSTEM.md`（或 `$DSH_HOME/SYSTEM.md`）与项目级工作区配置 `.dsh/SYSTEM.md`（或 `SYSTEM.md`）。权责清晰，与面向角色的 `AGENTS.md` 解耦。
- **毫秒级防抖热重载（Hot-Reload）**：
  基于 `fs.watch` 深度监视提示词文件变更，修改保存后下一轮交互即刻生效，无需重启 DSH 守护进程。
- **级联策略灵活可选**：
  支持 `concat`（全局与工作区级联合并，默认）与 `workspace-override`（项目级完全覆盖全局）。
- **内置 Prompt Linter 健康度校验与一键修复**：
  提供 `lintPrompt` / `fixPrompt` / `lintPromptFile` API。**基于用户当前预设加载的插件工具做动态客观判定**，杜绝主观臆断：当工具未在预设加载时提示冗余防守，当工具已加载却声明禁用时提示配置冲突，并校验弱语气词（如软性建议词自动升级为标准动词）、RFC 2119 强约束大写规范及未闭合反引号，输出健康度打分（0-100）并支持一键无损修复。

| 指标维度 | 官方默认 System Prompt | 开启本插件优化后 | 收益 |
| :--- | :--- | :--- | :--- |
| **提示词上下文开销** | ~2,000 tokens / 轮 | **~380 tokens / 轮（推荐模板）** | **大幅释放有效上下文，杜绝冗余规则消耗** |
| **长轮次会话累积** | 50 轮累计消耗 ~100K 冗余上下文 | 上下文干净紧凑，核心指令专注 | **显著缓解上下文漂移与遗忘** |
| **配置修改生效** | 需重启服务或重载配置文件 | 文件修改保存即刻热生效 | **即写即调，毫秒级响应** |

### 2. PTC 原生复合批处理工具 (`compositeTools`)

- **`read_batch`**：
  支持单次并发读取最多 10 个指定文件的文本片段。大幅加速多模块依赖排查、跨文件上下文搜集任务。
- **`edit_batch`**：
  支持单次顺序执行最多 10 处跨单个或多个文件的字面量精准文本替换。容忍局部错误而不影响同批次其他成功编辑，彻底避免多轮串行 `edit` 带来的网络空转。
- **原生沙箱与安全事务继承**：
  所有子操作均通过官方 `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) 分发，完整保留 DSH 沙箱权限判定、文件变更审核与观察策略钩子。

### 3. 运行期硬防护与失败自愈机制

- **连续无进展失败熔断 (`NO_PROGRESS`)**：
  基于输入参数指纹计算，当同一工具以相同参数连续失败达到 `noProgressLimit`（默认 `2` 次）时，在 `tools/pre-execute` 阶段立即硬拦截并强迫模型转换诊断思路，杜绝死循环。
- **Windows 超大 Shell 载荷拦截 (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**：
  自动拦截超过 `4096` 字节的 `bash` 命令，或超过 `512` 字节的内联脚本参数（`node -e`、`python -c`、`pwsh -Command` 等），引导模型先通过原生 `write` 落盘再执行，规避 Windows 命令行参数溢出崩溃。
- **Windows 重型任务串联死锁防御 (`CHAINED_HEAVY_COMMAND`)**：
  在 `tools/pre-execute` 阶段自动拦截将重型并发或发布操作（`npm test`, `npm run build`, `vitest`, `npm publish`）与其他命令串联的复合语句，强行引导单列执行重型任务以防 Windows 死锁，同时彻底放行轻量确定性操作（`git add ... && git commit ... && git push`）链式执行，最大化节省交互轮次。
- **Playwright 文件协议前置拦截 (`PLAYWRIGHT_FILE_PROTOCOL_BLOCKED`)**：
  在 `tools/pre-execute` 阶段主动检测并拦截 `playwright-cli open/goto file://...` 调用，立即引导模型使用本地 HTTP 环回服务访问，防止浏览器僵尸子进程残留与协议阻断异常。
- **大文件覆写防御与快速重放恢复 (`failureRecovery`)**：
  保护已存在的大文件不被全量 `write` 误覆盖；针对大文件写入（8KB–1MB）因缺失配对 `justification` 被拒的场景，提供 `retry_failed_write` 快捷工具，由宿主从缓存直接重放，避免大模型重新生成数千行代码。

### 4. 轻量软收敛提示与客观 A/B 度量

- **轻量微指令收敛 (`convergence`)**：
  在步数达到阈值后追加精简的 `notice` 收敛引导（默认 `stepInterval: 8`，每轮上限 `4` 次），且内置**错误感知避让**：模型上一步工具调用报错时自动静默，优先保证排错连贯性。
- **客观 A/B 效果度量 (`telemetry`)**：
  内置细粒度性能度量，实时追踪模型请求数、工具调用数、批处理并发比率（`parallelismRatio`）、首字延迟（TTFT）、Token 消耗与前缀稳定性（`prefixChanges`），支持基线差值对比。

---

## 安装与快速上手

### 1. 通过 DSH 插件命令安装（推荐）

```bash
# 直接安装至当前激活的 web profile
dsh plugin --profile web add dsh-awesome-optimizer
```

### 2. 通过 npm / pnpm 安装

```bash
# 使用 npm
npm install dsh-awesome-optimizer

# 使用 pnpm
pnpm add dsh-awesome-optimizer
```

### 3. 零配置开箱即用

本插件在安装后**开箱即用，默认最佳实践已全量激活**。用户的全局 `cordis.patch.yml` **无需添加任何多余配置行**。

#### 高级定制 / 仅维护禁用配置（可选）
仅在需要覆盖默认路径或禁用某项能力时，才需在 `cordis.patch.yml` 中声明：

```yaml
# 示例：仅在需要覆盖或局部禁用时编写
- id: agent-optimizer
  config:
    # 局部停用系统提示词接管（改用官方默认）
    customPrompt:
      enabled: false

    # 或微调批处理大小
    compositeTools:
      maxBatchFiles: 15
      maxBatchEdits: 15

    # 或放宽无进展熔断阈值
    runtimePolicy:
      noProgressLimit: 3
```

---

## 生产级 SYSTEM.md 最佳实践

配合 `placement: "replace-all"` 模式，推荐在全局目录创建 `~/.dsh/SYSTEM.md`（Windows 下为 `C:\Users\<用户名>\.dsh\SYSTEM.md`）：

<details>
<summary>点击展开查看开箱即用通用提示词模板（50 行，纯原生工具无外部依赖）</summary>

```markdown
# AUTONOMOUS AGENT CORE DIRECTIVE

You are a master autonomous software engineer powered by DeepSeek Harness.

- Prioritize direct action over speculation: investigate via concurrent tools (fs, bash, skills) without orchestration overhead.
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
- Windows arguments & paths: use forward slashes in paths to prevent escape corruption. NEVER embed multiline or complex scripts in shell arguments (`node -e`, `python -c`, `pwsh -Command`). Quote single-line patterns carefully (`ast-grep` patterns STRICTLY in single quotes `'...'` to prevent `$$` expansion). On quoting failures, switch input method rather than re-escaping.
- Byte-fidelity: default new text files to UTF-8. Preserve existing file encodings, BOMs, line endings, `.gitattributes`, and hook policies unless explicitly requested.
- Policy denials (`file access denied`, network blocked, approval disabled/rejected) are not command bugs: report; do not bypass. Request wider access via `sandbox_permissions` ONLY when escalation is explicitly available; otherwise do not retry or escalate. Diagnose ordinary lock, permission, or connectivity errors normally.
- Tool exclusivity: STRICTLY native `glob`/`grep`/`read_batch`/`read`/`edit_batch`/`edit`/`write`. NEVER use shell commands or redirects for workspace search or reading/writing files (`grep`, `rg`, `find`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `sed`, `awk`, `tee`, `>`/`>>`). Filtering piped command output (`cmd | grep`) and batch removing temporary artifacts (`rm -rf`) are permitted.

### Execution & Context Efficiency

- Workflow:
  - Complexity: simple → execute; high-scope (cross-module, API, schema) → generate / follow plan (`<name>.md`); define 1–3 sentence scope and exit criteria before edits.
  - Scheduling: MUST use `read_batch` for multi-file inspection (2+ files); keep single-file reads, retries, and dependent checks sequential.
  - Diagnosis: inspect contiguous context in one pass; cite locators and minimal raw excerpts only as evidence.
- Search & navigation:
  - Scope & environment: verify via `git rev-parse --is-inside-work-tree` when workspace boundary is ambiguous (do not probe `.git`). Probe binary availability via `which`/`command -v` ONLY when execution fails.
  - Runtime context: `pwd`/runtime cwd defines the workspace; the DSH implementation checkout is ONLY for inspecting/extending DSH—NEVER infer cwd from it or edit it unless explicitly requested.
  - Code intelligence: prioritize `lsp` CLI (`lsp def`, `lsp ref`, `lsp hover`); outline via `lsp symbols <file>` or `ast-grep outline` before reading large files; `ast-grep` for structural queries (`-p`, `-k`; `ast-grep run` exit 1 means 0 matches, not error; `scan` exits 0 either way).
  - Files & text: native `glob`/`grep` (gitignore-aware by default; pass `gitignore: false` for ignored paths); broad matches → narrow `path`/glob or page via `skip`, NEVER truncate blindly. Use `git` via `bash` ONLY for git-specific facts (tracked status, history, diffs).
- Modification & execution:
  - File ops: MUST use `edit_batch` for 2+ edits (whether in one file or across multiple files); use `edit` for a single edit, and `write` for new files or ad-hoc Node/Python scripts.
  - Staged refactor: preview, then apply — symbol renames via `lsp rename` (dry-run → `--apply`); structural rewrites via `ast-grep run -p ... -r ...` (then `-U`).
  - Structured data & calculations: MUST write ad-hoc Node/Python scripts to disk first via native `write` and execute by file path; NEVER embed calculations or processing in `python -c` or `node -e`.
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

## 本地验证与基准测试

```bash
# 从本地已安装的 DSH 宿主链接依赖（零网络请求）
npm run setup:local

# 在官方 @deepseek-ai/dsh-agent-loop 上运行完整集成测试
npm test

# 运行 TypeScript 严格类型检查
npm run typecheck

# 运行离线 A/B 机制与度量对照脚本
npm run benchmark
```

---

## 设计边界与安全保障

1. **官方 Loop 独占控制流 (`@deepseek-ai/dsh-agent-loop`)**：
   生命周期、工具原生并发调度（`maxParallelToolCalls`）、重试、取消与结束语义全部由官方 Loop 负责。本插件通过 Cordis 机制注入，**绝不禁用、替换或篡改** `@deepseek-ai/dsh-agent-loop`。
2. **零模型参数篡改**：
   本插件绝不在 `agent/request` 钩子中擅自降低或修改模型名称、Provider 或推理强度（`reasoningEffort`）。
3. **事务性与沙箱透明度**：
   复合工具执行的所有原子子操作均在官方执行管线中逐一审计与授权，绝不绕过安全边界。

---

## 许可证

[MIT](LICENSE) © [Jaylor-Wang](https://github.com/Jaylor-Wang)
