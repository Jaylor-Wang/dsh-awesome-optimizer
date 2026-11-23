# dsh-awesome-optimizer

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-awesome-optimizer.svg?color=blue)](https://www.npmjs.com/package/dsh-awesome-optimizer)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-awesome-optimizer.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-awesome-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-awesome-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-207%20passed-brightgreen.svg)](test/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](src/)

围绕官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-agent-loop`) 打造的高性能运行时策略防护、持久化 Python/Node 执行内核、PTC 复合批处理工具、全新独立系统提示词接管与客观 A/B 轮次度量插件。

---

## v4.3.0 更新亮点

- **效率信号驱动软收敛 (`convergence`)**：默认升级为 `mode: "adaptive"`（保留 `periodic` 兼容），仅在出现效率退化信号时追加极简 `notice`——连续单工具只读达到 `serialReadThreshold`（默认 `4`）时引导并行批读或使用 `find_and_read`，长尾探索达到 `longTailStepThreshold`（默认 `12`）且连续 `stallStepsThreshold`（默认 `6`）步无编辑/验证时给出带客观步数锚点的收敛提示；活跃编辑/验证全程静默，健康高并行批读自动 2× 拉长阈值与冷却；引入 `cooldownSteps: 6` 杜绝报错恢复后连发、过滤复合工具子调用（`exec.parent`）、补齐跨轮 `snapshotEvents()` 回放，并按实际准入工具动态裁剪 `buildGuidance`。
- **复合工具加固与模块化 (`find_and_read` / `edit_batch`)**：修复 `find_and_read` 的 `read` 准入校验漏传 `exec.toolSet`、`parseGrepOutput` 合并去重统一规范化 Windows/POSIX 路径、`find-read-ranking.js` 声明优先扩展至 TS 类/箭头函数与 Python/Go/Rust；将 `edit_batch` 拆分为独立模块 `src/edit-batch.js`，修复 `resolve` 失败重复调用与权限拒绝原因透传，并在非 `atomic` 模式下按解析后的物理身份合并别名路径预检与熔断。
- **共享有界预检与 `readGuard` 性能优化**：抽取共享 `src/fs-preflight.js` 统一 `readGuard`、`editRecovery` 与 `edit_batch` 的有界读取与 `workingDirectory`/`fs` 安全获取（同步加固 `runtimePolicy` 与 `fileMutationPolicy`）；将 `readGuard` 本地回退改为按需分块读取、把 `code-outline.js` 热循环内 3 处正则提取为顶层预编译常量、跳过无扩展名非代码文件盲读 I/O、补齐 `retry_failed_write` 缓存失效，并为 `ast-outline.js` 计时器添加 `.unref?.()`。

---

## 核心特性与架构设计

### 1. 系统提示词精简与文件驱动热重载 (`customPrompt`)

- **独立接管模式 (`placement: "replace-all"`)**：
  在 DSH 官方 `system-prompt/assemble` 组装瀑布流中，精确剥除官方 verbose 冗余章节（包括 `harness:*`、`deployment:*`、`tool:*`、`deliverable:*`、`web:*` 等），并保留会话收敛指导等协同章节，将系统提示词基线精简至约 380 tokens 的轻量核心指令。此模式会主动放弃这些官方 prompt sections；仍需保留的指令应自行补入 `SYSTEM.md`。
- **双层 Markdown 规约**：
  自动寻找全局配置 `~/.dsh/SYSTEM.md`（或 `$DSH_HOME/SYSTEM.md`）与项目级工作区配置 `.dsh/SYSTEM.md`（或 `SYSTEM.md`）。权责清晰，与面向角色的 `AGENTS.md` 解耦。
- **毫秒级防抖热重载（Hot-Reload）**：
  基于 `fs.watch` 深度监视提示词文件变更，修改保存后下一轮交互即刻生效，无需重启 DSH 守护进程。
- **级联策略灵活可选**：
  支持 `concat`（全局与工作区级联合并，默认）与 `workspace-override`（项目级完全覆盖全局）。

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
  通过原生编辑管线顺序执行最多 10 处字面量替换。`atomic: true` 要求每个目标的快照可验证，不接受 `sandbox_permissions`；预检有任何失败均不下发编辑。开始执行后，严格模式遇到首个失败即停止，但不会回滚已应用的编辑，也不是跨文件事务。混合结果标记 `[PARTIAL]`，严格模式还会返回 `EDIT_BATCH_PARTIAL` 错误码；不要重试已成功的编辑。
- **继承原生沙箱与审计**：
  所有子操作均通过官方 `ToolExecutionPipeline` (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) 分发，完整保留 DSH 沙箱权限判定、文件变更审核与观察策略钩子。
### 3. 运行期硬防护与失败自愈机制

- **连续无进展失败熔断 (`NO_PROGRESS`)**：
  基于输入参数指纹计算，当同一工具以相同参数连续失败达到 `noProgressLimit`（默认 `2` 次）时，在 `tools/pre-execute` 阶段立即硬拦截并强迫模型转换诊断思路，杜绝死循环。
- **Windows 超大 Shell 载荷拦截 (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**：
  自动拦截超过 `4096` 字节的 `bash` 命令，或超过 `512` 字节的内联脚本参数（`node -e`、`python -c`、`pwsh -Command` 等），引导模型先通过原生 `write` 落盘再执行，规避 Windows 命令行参数溢出崩溃。
- **Bash 命令串联 (`CHAINED_HEAVY_COMMAND`)**：
  在 `enforce` 模式下，插件拦截用 `&&` 或 `;` 串联的 `npm publish`。测试和构建默认允许串联。设置 `runtimePolicy.disallowChainedHeavyCommands: true` 可额外拦截包含 `npm test`、`npm t`、`npm run build` 或 `vitest` 的串联命令。旧配置 `disallowChainedNetworkCommands` 仍可作为后备选项。
- **Playwright 文件协议前置拦截 (`PLAYWRIGHT_FILE_PROTOCOL_BLOCKED`)**：
  在 `tools/pre-execute` 阶段主动检测并拦截 `playwright-cli open/goto file://...` 调用，立即引导模型使用本地 HTTP 环回服务访问，防止浏览器僵尸子进程残留与协议阻断异常。
- **大文件覆写防御与快速重放恢复 (`failureRecovery`)**：
  保护已存在的大文件不被全量 `write` 误覆盖；针对大文件写入（8KB–1MB）因缺失配对 `justification` 被拒的场景，提供 `retry_failed_write` 快捷工具，由宿主从缓存直接重放，避免大模型重新生成数千行代码。

### 4. 轻量软收敛提示与客观 A/B 度量

- **效率信号驱动软收敛 (`convergence`)**：
  默认采用 `mode: "adaptive"`，不再按固定步数机械复读，而是仅在出现效率退化信号时追加极简 `notice`：连续单工具串行读/搜达到 `serialReadThreshold`（默认 `4` 步）时定向引导并行批读或使用 `find_and_read`；步数达到 `longTailStepThreshold`（默认 `12`）且近期连续 `stallStepsThreshold`（默认 `6`）步无编辑或验证进展时给出带客观步数锚点的收敛提示；健康高并行任务自动拉长 2 倍阈值与冷却期，正常变更/测试推进全程静默；内置 `cooldownSteps`（默认 `6`）杜绝报错恢复后连发、顶层工具报错避让（隔离复合工具子调用），并按实际可用工具动态裁剪系统提示指引。如需固定节拍可显式配置 `mode: "periodic"`。
- **客观 A/B 效果度量 (`telemetry`)**：
  追踪模型请求、工具调用、每批工具数（`parallelismRatio`）、首字延迟、Token 用量和适配器消息前缀变化（`prefixChanges`）。`getSummary(session, turn)` 只读查询最近跟踪的回合；更早或未知的回合返回空摘要。缓存用量和统计覆盖率见 [HTTP 缓存诊断](cache-diagnostics.md)。

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

插件无需额外配置即可工作。**默认注册 Python 和 Node 执行工具，并预热两种内核。** 子进程继承宿主环境变量和操作系统权限，不受 DSH 文件或 Shell 沙箱约束；Node VM、会话隔离和超时机制都不是安全沙箱。处理不可信工作区或要求沙箱执行的 profile 应设置 `persistentEval.enabled: false`，同时关闭工具注册和预热。

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
      maxFiles: 8
      maxBatchEdits: 15

    # 或放宽无进展熔断阈值
    runtimePolicy:
      noProgressLimit: 3
```

---

## 生产级 SYSTEM.md 最佳实践

配合 `placement: "replace-all"` 模式，推荐在全局目录创建 `~/.dsh/SYSTEM.md`（Windows 下为 `C:\Users\<用户名>\.dsh\SYSTEM.md`）：

<details>
<summary>点击展开 SYSTEM.md 提示词模板（53 行）</summary>

```markdown
# AUTONOMOUS AGENT CORE DIRECTIVE

You are a master autonomous software engineer powered by DeepSeek Harness.
- MUST act directly rather than speculate.
- NEVER emit pre-action narration. Deliver surgical edits and high-signal conclusions.
- Irreversible operations (`npm publish`): STRICTLY conservative and non-autonomous. NEVER bump versions or mutate artifacts to bypass failures; registry validation causes transient 404 or stale views—NEVER treat as failure or retry publish. MUST verify remote state with read-only commands before declaring status.

## Defaults

- Reply in Chinese; code comments and commit messages in English unless requested otherwise. In user-facing text, preserve Windows path formats as written (`E:\...`).
- Answer / explain / plan / review / diagnose: inspect and report without edits unless requested otherwise.
- Change / fix / build: make minimal, conservative, reversible edits within task scope, including necessary changes to related files. Preserve unrelated work; reset/clean the working tree ONLY if explicitly requested. No unrelated cleanup, reformatting, dependency changes, or test rewrites. May remove task-created temporary artifacts after use. New tests ONLY via Verification.
- Ask first (via `ask_user_question`) ONLY when ambiguity materially affects scope, architecture, or data safety; otherwise execute autonomously.
- Shell: ONLY `bash`. Launch `pwsh.exe` from `bash` when needed.
- Web: Research/fetch STRICTLY via skills (`agent-reach`, `gh`, `opencli-*`) or shell CLIs via `bash`.
- Retry ONLY when the error or new evidence supports a specific correction; after two failures without progress, switch diagnostic approaches.
- Windows arguments & paths: use forward slashes in paths to prevent escape corruption. NEVER embed scripts or multiline code in shell arguments (`node -e`, `python -c`, `pwsh -Command`). Quote single-line patterns carefully (`ast-grep` patterns STRICTLY in single quotes `'...'` to prevent `$$` expansion). On quoting failures, switch input method rather than re-escaping.
- Byte-fidelity: default new text files to UTF-8. Preserve existing file encodings, BOMs, line endings, `.gitattributes`, and hook policies unless explicitly requested.
- Policy denials: report and do not bypass; diagnose ordinary lock, permission, or connectivity errors normally.
- Tool exclusivity: STRICTLY native `glob`/`grep`/`find_and_read`/`read`/`edit_batch`/`edit`/`write`. NEVER use shell commands or redirects for workspace search or reading/writing files (`grep`, `rg`, `find`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `sed`, `awk`, `tee`, `>`/`>>`). Filtering piped command output (`cmd | grep`) and batch removing temporary artifacts (`rm -rf`) are permitted.

## Efficiency

### Execution & Context Efficiency

- Workflow:
  - Complexity: Execute simple tasks directly. For broader changes, define scope and acceptance criteria first. Write a plan file ONLY when explicitly requested.
  - Scheduling: For searches across multiple source files that need matching code and surrounding context, use `find_and_read`. For known files, batch independent `read` calls in parallel. Keep dependent inspections and retries sequential.
  - Diagnosis: Inspect contiguous context in one pass; cite locators and minimal raw excerpts only as evidence.
- Search & navigation:
  - Scope & environment: verify via `git rev-parse --is-inside-work-tree` when workspace boundary is ambiguous (do not probe `.git`). Probe binary availability via `which`/`command -v` ONLY when execution fails.
  - Workspace: use the session working directory; do not modify the DSH installation directory unless explicitly requested.
  - Code intelligence: Prioritize `lsp` CLI (`def`/`ref`/`hover`/`symbols`) and `ast-grep` (`-p`, `-k`, `outline`). `ast-grep run` exits with `1` on no matches. When `ast-grep scan` completes, it exits with `1` if any `severity: error` rules match and `0` otherwise.
  - Files: use native `glob` to locate files (including hidden/ignored files), `grep` to search contents, and `read` for focused excerpts (`offset`/`limit`). Narrow searches when results are capped; use `bash` for Git status, history, and diffs.
- Modification & execution:
  - File ops: MUST use `edit_batch` for 2+ edits (whether in one file or across multiple files); use `edit` for a single edit, and `write` for new files or ad-hoc Node/Python scripts.
  - Staged refactor: Preview with `lsp rename` or `ast-grep run -p 'PATTERN' -r 'REWRITE' PATHS`. Review the proposed edits and affected files, then rerun the same command with `--apply` or `-U`, respectively.
  - Structured data & calculations: MUST use persistent `eval_python`/`eval_node` kernels (key stdlib pre-imported) to query, filter, transform, and compute. Return compact results with minimal evidence; NEVER dump raw datasets or large intermediates. Follow tool rules for file access and external queries.
  - Chain steps with `&&`. Run long tests or builds separately when they need their own timeouts or logs. Run `npm publish` alone and verify the version via a read-only registry query.
- Reporting: diffs, locators, minimal excerpts, and evidence first; zero filler. Routine status ≤ 300 Chinese characters (do not omit required check results or verification gaps to fit). Answer/explain/review/diagnose/plan: no length cap.

## Verification

Applies ONLY to review / diagnose / change / fix / build.

- NEVER falsify tests (weaken assertions, stub a failing path, or skip a check to pass).
- Match checks to behavioral or contract risk; prefer existing checks. Review/diagnosis: run existing non-destructive checks as needed. Add or modify tests only for authorized changes; close coverage gaps in changed behavior. Repeat equivalent checks only when relevant code, configuration, environment, or evidence changes:
  - Text or mechanical changes without behavioral or contract effects: inspect the diff and relevant syntax/format; skip unrelated linters.
  - Behavior changes: check static diagnostics via primary tools (e.g. `lsp diag <file|dir> -e`, skip if language unsupported; no redundant CLI linters), then run the smallest non-destructive targeted build/test covering affected behavior and internal interfaces.
  - Shared API, schema, or migration changes: run the full related suite plus project-wide type checking where applicable (e.g. `tsc --noEmit`).
- Report checks, results, and verification gaps; if primary diagnostics are unavailable, use an existing equivalent check when possible.
- Browser checks: `playwright-cli` ONLY for read-only review/diagnosis and post-change verification. Reuse active app URLs; serve static HTML over loopback HTTP (`http://127.0.0.1:<port>`; `file:` blocked). Prioritize `snapshot`/`console`/`requests`; for visual checks, stabilize with `set-reduced-motion reduce` and omit `screenshot --filename` unless an explicit path is required. NEVER pre-probe (`--help`/`--version`), create dummy pages, or switch tools. Batch-clean sessions (`close`/`close-all`), temp servers, and `.playwright-cli/` without redundant listings.
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
3. **复合工具的沙箱与审计**：
   复合工具的子操作均通过官方执行管线逐一授权与审计。

---

## 许可证

[MIT](LICENSE) © [Jaylor-Wang](https://github.com/Jaylor-Wang)
