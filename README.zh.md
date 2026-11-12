# dsh-awesome-optimizer

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-awesome-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-awesome-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-awesome-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-awesome-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-awesome-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-21%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

围绕官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`) 打造的高性能运行时策略防护、PTC 复合批处理工具、全新独立系统提示词接管与客观 A/B 轮次度量插件。

---

## v1.7.0 版本重要更新

- **宿主环境事实注水全面加固与弱语气词拔除**：环境事实注水段落全面升级为 RFC 2119 绝对强约束，将模块与脚本边界严格收敛为 `NEVER require/import as node modules`，彻底封死 CommonJS 与 ESM 两种导入路径；将开局探测禁令拔除 `Avoid` 弱语气词并收敛为铁律 `NEVER run exploratory probing (pwd, ls, node -v, which)`。
- **Python 跨平台环境智能识别与单例缓存 (`detectPythonEnv`)**：在环境事实注水时自动探测当前系统 Python 可用性（`python` / `python3` 及版本号），抹平跨平台命令分歧；采用单例懒加载缓存与超时守卫，零首字延迟开销；未装配时自动引导模型纯粹使用 Node.js，杜绝盲目生成 `.py` 脚本导致的执行失败。
- **Playwright `file:` 协议前置硬拦截 (`PLAYWRIGHT_FILE_PROTOCOL_BLOCKED`)**：在 `tools/pre-execute` 阶段主动检测并拦截 `playwright-cli open/goto file://...`，杜绝协议阻断异常与浏览器僵尸子进程，引导模型无缝切换至本地 HTTP 环回服务。
- **轻量宿主环境事实注水 (`injectEnvironmentFacts`)**：系统提示词组装阶段自动注入 Node.js 版本、系统架构、独立 CLI 工具边界与 Playwright 协议指引，彻底消除模型开局盲目执行探针命令。
- **CLI 独立工具与 NPM 模块边界防混淆**：在 Prompt Linter 中新增 `cli-require-confusion` 静态规则，静态拦截将外部 CLI 工具当成 Node 模块导入的认知混淆错误。
- **复合批处理工具语义精准化与规范收敛**：`read_batch` 与 `edit_batch` 全面加固为 `MUST` 硬约束，精准规范单/多文件介词与数量阈值；精炼 Windows 参数与路径指令，去除冗余科普并强化 `NEVER raw shell arguments` 边界。

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
  提供 `lintPrompt` / `fixPrompt` / `lintPromptFile` API。**基于用户当前预设加载的插件工具做动态客观判定**，杜绝主观臆断：当工具未在预设加载时提示冗余防守，当工具已加载却声明禁用时提示配置冲突，并校验弱语气词（如 `bias toward` 自动升级为 `Prioritize`）、RFC 2119 强约束大写规范及未闭合反引号，输出健康度打分（0-100）并支持一键无损修复。

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
- **Windows 复合网络命令挂起防御 (`CHAINED_NETWORK_COMMAND`)**：
  在 `tools/pre-execute` 阶段自动拦截将网络/凭据操作（`npm publish` 等）与本地耗时操作混合串联的复合命令，强行引导模型执行两分法：本地确定性操作（`git add ... && git commit ... && npm test`）复合提速，网络发布独立把关，彻底规避 Windows 子进程句柄悬挂与 120s 超时。
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
- Irreversible operations (npm publish): STRICTLY conservative and non-autonomous. NEVER bump versions or mutate artifacts to bypass failures; registry validation causes transient 404 or stale views—NEVER treat as failure or retry publish. MUST verify remote state with read-only commands before declaring status.

## Defaults

- Reply in Chinese; code comments and commit messages in English unless requested otherwise. In user-facing text, preserve Windows path formats as written (`E:\...`).
- Answer / explain / review / diagnose / plan: inspect and report without edits unless requested otherwise.
- Change / build / fix: make the smallest in-scope edits necessary for the requested task; task authorization includes necessary edits to related files. Keep changes conservative and reversible. Preserve unrelated user work. Do not reset or clean the working tree unless explicitly requested. Do not perform unrelated cleanup, reformatting, dependency changes, or test rewrites. Task-created temporary artifacts may be removed after use. New tests ONLY via Verification.
- Ask first (via `ask_user_question`) ONLY when ambiguity materially affects scope, architecture, or data safety; otherwise execute autonomously.
- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.
- Web: Research/fetch STRICTLY via skills (`agent-reach`, `gh`, `opencli-*`, `smart-search`) or bash CLIs.
- Tool boundaries: External tools (playwright-cli, gh, ast-grep) are standalone CLIs via bash, NEVER require/import as node modules.
- Intermediate artifacts: Write ad-hoc Node/Python scripts to temporary files or clean them up; NEVER clutter the workspace with disposable test pages.

## Efficiency

### Hard Constraints

- Retry ONLY when the error or new evidence supports a specific correction; after two failures without progress, switch diagnostic approaches.
- Windows arguments & paths: use forward slashes in paths to prevent escape corruption. Pass complex/multiline payloads (`node -e`, `python -c`, `playwright-cli eval`, `gh`) via files or stdin, NEVER raw shell arguments; quote single-line patterns carefully (`ast-grep` patterns STRICTLY in single quotes `'...'` to prevent `$$` expansion). On quoting failures, switch input method rather than re-escaping.
- Byte-fidelity: default new text files to UTF-8. Preserve existing file encodings, BOMs, line endings, `.gitattributes`, and hook policies unless explicitly requested.
- Policy denials (`file access denied`, network blocked, approval disabled/rejected) are not command bugs: report; do not bypass. Request wider access via `sandbox_permissions` ONLY when escalation is explicitly available; otherwise do not retry or escalate. Diagnose ordinary lock, permission, or connectivity errors normally.
- Tool exclusivity: STRICTLY native `glob`/`grep`/`read_batch`/`read`/`edit_batch`/`edit`/`write`. NEVER use shell commands or redirects for workspace search or file ops (`grep`, `rg`, `find`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `sed`, `awk`, `tee`, `>`/`>>`). Filtering piped command output (`cmd | grep`) is fine.

### Execution & Context Efficiency

- Workflow:
  - Complexity: simple → execute; high-scope (cross-module, API, schema) → generate / follow plan (`<name>.md`); define 1–3 sentence scope and exit criteria before edits.
  - Scheduling: MUST use `read_batch` for multi-file inspection (2+ files); keep single-file reads, retries, and dependent checks sequential.
  - Diagnosis: inspect contiguous context in one pass; cite locators and minimal raw excerpts only as evidence.
- Search & navigation:
  - Scope & environment: verify via `git rev-parse --is-inside-work-tree` when workspace boundary is ambiguous (do not probe `.git`). Probe binary availability via `which`/`command -v` ONLY when execution fails; NEVER run speculative probing (`node -v`, `node -e`, `playwright-cli --version`) on startup—host facts are already hydrated.
  - Runtime context: `pwd`/runtime cwd defines the workspace; the DSH implementation checkout is ONLY for inspecting/extending DSH—NEVER infer cwd from it or edit it unless asked.
  - Code intelligence: prioritize `lsp` CLI (`lsp def`, `lsp ref`, `lsp hover`); outline via `lsp symbols <file>` or `ast-grep outline` before reading large files; `ast-grep` for structural queries (`-p`, `-k`; `ast-grep run` exit 1 means 0 matches, not error; `scan` exits 0 either way).
  - Files & text: native `glob`/`grep` (gitignore-aware by default; pass `gitignore: false` for ignored paths); broad matches → narrow `path`/glob or page via `skip`, NEVER truncate blindly. Use `git` via `bash` ONLY for git-specific facts (tracked status, history, diffs).
- Modification & execution:
  - File ops: produce deliverables directly; MUST use `edit_batch` for 2+ edits (whether in one file or across multiple files); use `edit` for a single edit, and `write` for new files or ad-hoc Node/Python scripts.
  - Staged refactor: preview, then apply — symbol renames via `lsp rename` (dry-run → `--apply`); structural rewrites via `ast-grep run -p ... -r ...` (then `-U`).
  - Structured data: process STRICTLY via ad-hoc Node/Python scripts passed via stdin or temp files; NEVER dump raw data into context.
  - Shell execution: prioritize chaining local non-blocking operations via `&&` (`git add ... && git commit ... && npm test`) to eliminate round-trip latency; keep network- or credential-bound commands (`npm publish`, remote fetch) separate to prevent Windows process handle hanging and timeouts.
- Reporting: diffs and evidence first; zero filler. Routine status ≤ 300 Chinese characters. Answer/explain/review/diagnose/plan: no length cap. Compact locators, lists, and deltas only.

## Verification

Applies ONLY to change/build/fix.

- NEVER falsify tests (weaken assertions, stub a failing path, or skip a check to pass).
- Choose checks by the highest affected behavioral or contract risk. Prioritize existing relevant checks; add a targeted test when changed behavior lacks coverage. Do not repeat equivalent checks unless code, configuration, environment, or relevant evidence changes:
  - Text or mechanical changes without behavioral or contract effects: inspect the diff and relevant syntax/format; skip unrelated linters.
  - Behavior changes: check static diagnostics via primary tools (e.g. `lsp diag <file|dir> -e`, skip if language unsupported; no redundant CLI linters), then run the smallest non-destructive targeted build/test covering affected behavior and internal interfaces.
  - Shared API, schema, or migration changes: run the full related suite plus project-wide type checking where applicable (e.g. `tsc --noEmit`).
- Report checks, results, and verification gaps; if primary diagnostics are unavailable, use an existing equivalent check when possible.
- Browser checks: STRICTLY `playwright-cli` post-write. Playwright CLI blocks 'file:' URLs—serve static HTML via loopback HTTP (http://127.0.0.1:<port>). NEVER pre-probe (`node -v`, `playwright-cli --version`), create dummy pages, or switch tools. Reuse runtime Web GUI or active app URL (loopback for static); stabilize animations before capture. Batch-cleanup sessions/servers/artifacts without redundant listings. On failure, report root cause.
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
