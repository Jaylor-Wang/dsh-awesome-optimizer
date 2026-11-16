# dsh-awesome-optimizer

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-awesome-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-awesome-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-awesome-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-awesome-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-awesome-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-155%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

围绕官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`) 打造的高性能运行时策略防护、持久化 Python/Node 执行内核、PTC 复合批处理工具、全新独立系统提示词接管与客观 A/B 轮次度量插件。

---

## v3.2.0 精准检索、结构大纲与缓存治理

- **检索与读取预算**：`find_and_read` 对完整 UTF-8 输出实施硬预算，保留原始正则和上游恢复位置，限制单窗口、累计读取行数与并发；按新增模式覆盖度和单位行信息量选择窗口。
- **更安全准确的大纲**：通过 fs 服务预检与有界读取处理访问拒绝和取消；增强 JS/TS/Python/Go/Rust 词法识别，按需使用 ast-grep 补足 JSX/TSX 等场景。CLI 仅接收已授权的 stdin 快照，具备超时、输出上限和词法回退。
- **版本缓存与释放**：有界大纲缓存按会话、后端、文件身份、语言和版本隔离；通过官方会话释放事件清理缓存与统计，阻止进行中的检查在释放后回填。
- **缓存指标**：统一 telemetry 的独立 `summary.readGuard` 快照提供查询、命中、未命中、绕过、修改失效次数与明确口径的命中率；统计每轮重置，缓存跨轮复用。
- **Windows 实测**：提供可复现的真实 CLI 测量脚本、`outline-benchmark.md` 和原始 JSON；数据反映本地处理耗时，不代表供应商缓存率或模型加速比例。
- **验证**：155 项测试通过，公开声明类型检查及静态诊断通过。无新增包依赖，ast-grep 为可选外部 CLI。

## v3.1.0 工作区感知与工程分析增强

- **持久化 eval 工作区同步**：Python / Node worker 通过每次执行请求同步会话工作目录，并注入 `CWD`。目录变化保留用户状态；无效目录会在 reset 或用户代码执行前报错。取消和超时重启后恢复请求目录。
- **Python 工程分析标准库**：在已有标准库基础上预导入 `pathlib`、`difflib`、`csv`，reset 后同样可用。支持通过相对路径进行 i18n key 对齐等项目核查，并返回紧凑摘要。
- **精简 Python 异常栈**：剥离 worker 内部帧，保留 `<eval_kernel>` 位置、库调用帧、语法错误源码与指示位置，以及异常链和异常组。
- **验证**：98 项测试通过，覆盖会话隔离、排队目录切换、中文路径、相对路径文件分析及 worker 恢复；公开声明类型检查通过。

## v3.0.0 架构减法与精准定位升级

- **精准检索切片工具（`find_and_read`，正式剔除 `read_batch`）**：
  - 彻底移除与 DSH 原生并行 `read` 重叠且易诱导盲读整文件的 `read_batch`，以基于 `ToolExecutionPipeline` 的 **`find_and_read`** 接管探索阶段。
  - 单次支持 1~5 个正则并行 `grep` 检索，按模式覆盖度去重排序文件，自动合并相邻/重叠的 `±contextLines` 行区间再派发 `read` 切片，严格受 `24KB` 字节预算控制（超出部分降级为紧凑 `path:line` 索引）。
- **原生 `read` 零工具位护栏与盲读尾部骨架（`readGuard`）**：
  - 通过 `tools/post-execute` 无感保护所有原生 `read` 调用：截断超长压缩单行（`maxLineChars: 1500`），并在未指定 `offset/limit` 盲读大文件被截断时，于末尾自动附带剩余行（≤20 条）的轻量符号骨架，零额外 Tool Schema 开销。
- **零成本 `edit` / `edit_batch` 匹配失败上下文自愈（`editRecovery`）**：
  - 当 `edit` 或 `edit_batch` 因缩进/CRLF/局部过期导致匹配失败时，自动回显带精确行号的附近源码（支持多处命中行号清单、缩进差异诊断、稀有锚点与 Token 滑窗兜底），且严格跳过权限/沙箱/`NO_PROGRESS`/`ENOENT` 拦截以防止内容泄露。

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

- **`find_and_read`**：
  单次并行执行 1~5 条正则 `grep`，保留正则原始空白语义，自动合并并拆分邻近命中区间，经原生管线分批 `read`，一跳替代 `grep → 等待 → read`。完整返回文本（含标题、错误、索引和省略说明）受 `maxTotalBytes` 硬限制，默认 24KB；优先保留命中行，未展示位置降级为索引，索引也放不下时明确计数。上游截断、模式失败、匹配总数及可容纳的恢复定位会显式保留。
  - `maxWindowLines: 120`：单次切片最多请求的行数，防止密集命中连锁合并为整文件读取。
  - `maxReadLines: 600`：单次调用累计请求行数上限，包含多个文件及窗口。
  - `readConcurrency: 3`：每批最多同时读取的窗口数；每批完成后重新核算输出空间，空间不足时停止后续读取。原生读取自身截断所隐藏的命中仍进入索引。
  - 窗口按尚未覆盖的正则数优先选择，再考虑重复模式的边际收益、行数成本及文件多样性；同分时按规范路径与行号稳定排序。`maxFiles` 限制实际选中的文件，不提前排除其他文件中的高价值窗口。
  - 以上是行数与输出字节上限，不代表底层读取字节数或 Token 的固定换算。
- **`readGuard` 读取前检查**：
  仅对支持的大纲语言执行附加检查；先经 fs 服务解析路径、检查文件类型与大小，再优先使用有界 `readBytes` 或文本流。超过 `maxInspectBytes`（默认 512KB）、取消、文件不存在或服务拒绝访问时跳过大纲，不改写原生读取结果。服务失败后不回退到本地磁盘；旧版仅有 `readText` 的服务在大小检查通过后兼容读取，仍受文件检查后变大的竞态限制。
  - 默认 `astOutline: "auto"`：普通文件用轻量词法扫描；JSX/TSX、TS 装饰器/导出命名空间以及存在声明但词法结果为空的文件按需调用 ast-grep。可设 `"off"` 禁用或 `"always"` 对支持语言强制使用 AST。词法扫描支持 JS/TS/Python/Go/Rust 跨行声明、局部箭头与 Unicode 标识符；两级结果均优先顶层导出并在尾部采样。
  - AST 只从 stdin 接收 fs 已校验的内容快照，不让 CLI 读取目标路径；使用插件内固定配置、禁用自定义语言库且不经 shell。`astTimeoutMs: 750`、`astMaxOutputBytes: 262144` 限制耗时与输出；取消会终止子进程，缺少 CLI/超时/失败时回退词法结果。`astGrepCommand` 可指定可执行文件名或绝对路径；需要支持 `outline --stdin --json` 的 ast-grep。
  - 当前 ast-grep 内置规则只提供 TS 命名空间本身；命名空间内部保留词法识别的子声明，避免丢失导航位置。AST 成功结果及失败后的词法结果一起进入版本 LRU，同一文件版本的后续盲读不会再次启动 CLI；版本变化、写入或缓存淘汰后可重新尝试。可通过 `astAttempts/astSucceeded/astFallbacks/astTimeouts/outlineCacheHits` 统计验证。
  - Windows 测量可运行 `npm run benchmark:outline -- outline-benchmark.windows.json`：真实 CLI、20 次重复样本，分别报告首次调用、未缓存重复解析、词法路径与版本缓存命中；详细方法和本机结果见 `outline-benchmark.md`。
  - 大纲缓存按会话、fs 后端、解析后的文件身份、语言与版本隔离，每次仍执行 stat，首次读取后再次验证版本。默认 `maxCacheEntries: 32`、`maxCacheBytes: 262144`，缓存符号条目并按当前截断位置筛选；无可靠版本时不缓存，写入/编辑/执行代码及会话销毁会清除缓存，`maxCacheEntries: 0` 可关闭缓存。字节上限按序列化缓存载荷计，不等于 JS 堆占用。
  - 通过官方独立的 `session/disposed` 事件释放该会话所有后端缓存、强引用与统计；插件卸载清空剩余缓存。释放期间的检查不会重新填充缓存或注入迟到的大纲，其他会话不受影响。
  - `getStats(session)` 返回独立的每轮统计快照，统一 telemetry 的 `summary.readGuard` 同步提供，禁用 readGuard 时为 `null`。`outlineCacheLookups = outlineCacheHits + outlineCacheMisses`，`outlineCacheHitRate = hits / lookups`（0–1，无查询时为 `null`）。只有预检成功、缓存启用且文件身份/版本有效才计入查询；不存在、过期、被淘汰的条目均算 miss，后续读取或解析失败仍保留 miss。禁用、无身份/版本或本地独立后端计为 `outlineCacheBypasses`，预检拒绝不计查询或 bypass；普通/定向 read 不进入大纲查询分母。
  - `outlineCacheInvalidations` 统计清除已有会话缓存组（包括进行中的检查）的写入/编辑/bash/eval 事件次数；无缓存组时不计，版本不匹配计 miss，释放清理不计失效。统计在 `turn/start` 重置，缓存可跨轮复用。这些指标只描述本地大纲缓存，与模型输入缓存命中率分别计算。
- **`edit_batch`**：
  支持单次顺序执行最多 10 处跨单个或多个文件的字面量精准文本替换，内置同文件内存预演校验、`atomic` 原子中止及匹配失败行号自愈提示。
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
  - Structured data & calculations: Prioritize persistent kernels (`eval_python`, `eval_node`) for stateful computation, inverse kinematics, or data exploration without disk pollution. For deliverable scripts or build pipelines, MUST write to disk first via native `write` and execute by file path; NEVER embed scripts, calculations, or processing in `python -c` or `node -e`, and NEVER dump raw data into context.
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
