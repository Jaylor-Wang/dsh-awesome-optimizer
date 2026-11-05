# dsh-plugin-agent-optimizer

> 围绕官方 DeepSeek Harness (`@deepseek-ai/dsh-agent-loop`) 构建的非侵入式运行期防护、PTC 复合批处理工具、轻量软预算提醒与客观 A/B 轮次度量插件。

[![Release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-plugin-agent-optimizer.svg)](https://github.com/Jaylor-Wang/dsh-plugin-agent-optimizer/releases)
[![Tests](https://img.shields.io/badge/tests-10%20passed-brightgreen.svg)](test)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-red.svg)](README.zh.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 设计边界与工程原则

`dsh-plugin-agent-optimizer` 严格将 **“循环控制（Loop Lifecycle）”** 与 **“局部策略优化（Policy & Tooling）”** 解耦：

1. **官方 Loop 独占控制流 (`@deepseek-ai/dsh-agent-loop`)**：
   - 生命周期、工具原生并发调度（`maxParallelToolCalls`）、重试、取消与结束语义全部由官方 Loop 负责。
   - `cordis.patch.yml` 仅通过 `- insert:` 追加挂载本插件，**绝不禁用或替换** `@deepseek-ai/dsh-agent-loop`。
2. **严禁在 `agent/request` 钩子中篡改推理强度**：
   - 官方 Loop 会在每步校验请求参数与本步骤已选配置的一致性。本插件绝不挂载 `agent/request` 临时修改 `model`、`provider` 或 `reasoningEffort`。如需对比快慢模型或不同推理等级，应通过官方模型选择路径配置并与基线对照。
3. **运行期硬防护 (`src/runtime-policy.js`)**：
   - **连续无进展失败拦截 (`NO_PROGRESS`)**：基于确定性工具指纹，当同一操作连续失败达到 `noProgressLimit`（默认 `2` 次）时在 `tools/pre-execute` 阻断，防止无效重试死循环。
   - **Windows 超大 Shell 载荷拦截 (`EMBEDDED_SHELL_PAYLOAD_TOO_LARGE`)**：拦截超过 `4096` 字节的 `bash` 命令或超过 `512` 字节的内联脚本参数（`node -e`、`python -c`、`pwsh -Command`），引导模型先通过原生 `write` 落盘再按路径执行，彻底避免 Windows `spawn ENAMETOOLONG`。
4. **文件变更保护与大文件写恢复 (`src/file-mutation-policy.js`, `src/failure-recovery.js`)**：
   - 区分本轮新建文件与已存在文件，保护已有大文件不被整文件 `write` 意外覆盖（引导使用 `edit`）。
   - 当大文件写入（`8KB–1MB`）因未配对的 `justification` 被拒时，提供单次 `retry_failed_write` 恢复工具，通过 `ToolExecutionPipeline` 复用原文重放，避免模型重新生成大段内容。
5. **PTC 复合批处理工具 (`src/composite-tools.js`)**：
   - 提供 `read_batch` 工具，支持单次调用并发读取最多 `10` 个文件片段，真正从物理往返上减少多文件顺序读取的轮次。
   - 每个子读取均通过官方 `ToolExecutionPipeline` 分发，完整保留沙箱权限与策略钩子，并容忍单文件局部缺失而不丢失同批次其他文件的读取结果。
6. **轻量收敛指导 (`src/convergence.js`)**：
   - 注入并行调用与收敛提示词，并在达到 `softStepBudget`（默认 `8` 步）时追加一次提醒消息。
   - **客观说明**：软预算提醒会追加一条 `notice` 消息，它不是硬停止条件，本身不能单靠提示词承诺减少模型请求，且会增加少量输入 token（由 `telemetry` 精确记录）。
7. **客观 A/B 度量 (`src/telemetry.js`)**：
   - 统计模型请求数（`modelRequests`）、工具调用数（`toolCalls`）、PTC 子调用数（`ptcSubCalls`）、工具并行批次比（`parallelismRatio = toolCalls / toolBatches`）、失败次数、耗时、Token 消耗与前缀稳定性（`prefixChanges`），支持与基线直接计算差值。

---

## 本地验证与基准测试

```bash
# 从本地已安装的 DSH 宿主链接依赖（零网络请求）
npm run setup:local

# 在官方 @deepseek-ai/dsh-agent-loop 上运行完整集成测试
npm test

# 运行 TypeScript 类型声明检查
npm run typecheck

# 运行离线 A/B 机制与度量对照脚本
npm run benchmark
```
