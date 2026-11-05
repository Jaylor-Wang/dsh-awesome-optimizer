## English

### What's New in v0.9.0

- **`edit_batch` Composite Batch Tool**:
  - Introduced `edit_batch` alongside `read_batch` to collapse multi-file or multi-location literal text replacements into a single model round-trip.
  - Sub-dispatches sequentially via official `ToolExecutionPipeline` (PTC), strictly preserving sandbox modes, file mutation policies, and observation tracking.
  - Completely eliminates fragile Unified Diff line-number calculation errors and indentation mismatches typical of `apply_patch`.
  - Supports partial success with structured per-edit status reporting without losing valid changes.
- **Config & Guidance Updates**:
  - Added `compositeTools.editBatch` (default: `true`) and `compositeTools.maxBatchEdits` (default: `10`).
  - Updated convergence guidance to steer models toward `edit_batch` when making multi-file modifications.
- **Verification**:
  - Expanded test suite to 17 automated tests, all passing.

---

## 简体中文

### v0.9.0 更新日志

- **新增 `edit_batch` 复合批量修改工具**：
  - 与 `read_batch` 形成对称闭环，支持单次调用顺序执行最多 10 处跨单文件或多文件的字面量文本替换，将多文件重构轮次压缩至 1 轮。
  - 通过官方 `ToolExecutionPipeline`（PTC）顺序分发每一个子操作，完整继承沙箱权限、文件观察策略与审查记录。
  - 彻底规避官方 `apply_patch` 因 Unified Diff 行号少算/换行符微差导致的拒收错误，成功率与稳定性大幅提升。
  - 支持局部错误容忍与结构化状态返回，单点失误不破坏同批次其他有效修改。
- **配置与收敛指导升级**：
  - 新增 `compositeTools.editBatch: true` 与 `compositeTools.maxBatchEdits: 10` 配置项。
  - 收敛提示词自动引导模型在多文件/多位置修改时优先采用 `edit_batch`。
- **测试用例扩充**：
  - 自动化测试用例扩充至 17 项，全部通过。
