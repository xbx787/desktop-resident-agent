# CS146S 差距修复计划

依据：`docs/2026-10-24-cs146s-2026-gap.md`。
范围约束：只改 `.worktrees/dsh-p0`，不碰 Live2D 文件；每阶段独立可打包、可回滚。

## 总原则

- 一次只推进一个阶段，每阶段先写回归测试再改实现。
- 验收固定三步：`npm run check` → `npx vitest run` → 相关模块实机验证。
- 打包沿用 `WHALE_SKIP_LIVE2D_MOTION=1 npm run pack:release -- -ReleaseRoot D:\DesktopPetProject\release`，版本递增不重打旧号。

## 阶段 1：token / 成本统计（对应第 8–9 周）

**问题**：中断的轮次记账不完整，界面显示「用量未记录」。
**根因位置**：`src/main/agent-runtime.ts` 的 `accrueSpend()` 只在 `finishedAt` 存在且 `usage.input` / `usage.output` 都有值时才记账；`emit()` 只在 `done/failed/cancelled` 时补 `finishedAt`。

改动：
1. `agent-runtime.ts`：`cancelled` 与异常退出路径先落 `finishedAt` 再记账，顺序保证打开账单前已有时间戳。
2. 缺 `input`/`output` 但拿到 `total` 时，记录 `usedTokens` 并在账单标「费用未记录」，不再显示「用量未记录」。
3. `conversation-store.ts`：把已读到的 `taskMetrics.usage` 持久化，重开应用后仍能看到中断轮的 token。
4. 新增 `test/turn-stats.test.ts` 用例：中断、仅 total、正常完成三种。

验收：
- 中断一轮后，账单显示 token 数；有完整分桶时显示费用。
- 重开应用后，该轮数字不丢。
- 全量测试通过。

产出：0.0.115。

## 阶段 2：AGENTS.md 与 DSH hooks（对应第 4 周）

**问题**：只有 `CLAUDE.md` 读取；`AGENTS.md` 没有消费方；hooks 只在 Claude SDK 路径生效，DSH 主内核没有通用 hooks。

改动：
1. 新增 `src/main/agent-docs.ts`：按「仓库根 → 工作目录」顺序找 `AGENTS.md`、`CLAUDE.md`，合并成一段注入文本，带长度上限与去重。
2. `src/main/dsh-prompt.ts`：把这段文档接进宿主规则，每轮按 mtime 重读。
3. hooks：先在应用侧实现 `pre-tool` / `post-turn` 两个钩子点，配置读 `data/hooks.json`，拒绝规则走现有审批通道，不新开权限面。
4. 测试：文档合并顺序、超长截断、hooks 拒绝一次工具调用。

验收：
- 仓库放 `AGENTS.md` 后，下一轮生效。
- `hooks.json` 配一条拒绝规则，对应工具调用被拦下并显示原因。

产出：0.0.116。

## 阶段 3：轻量模型路由（对应第 9 周）

**问题**：只有 provider 与模型发现，没有按任务路由、故障转移、成本优先的抽象。

改动：
1. 新增 `src/main/model-router.ts`：输入「任务类型 + 当前 provider 健康状态」，输出 provider/model；先做规则表，不做在线学习。
2. 复用 `provider-health.ts` 的健康结果做故障转移；失败一次后短期降级到备用 provider。
3. `model-config.ts` / 设置页：暴露路由规则表，默认关闭，保持现有行为。
4. 测试：健康主 provider 走主路、失败后走备用、规则关闭时行为不变。

验收：
- 默认配置下行为与现在完全一致。
- 主 provider 故障时，下一轮自动切备用并在时间线标一次切换。

产出：0.0.117。

## 阶段 4：Agentic Code Review（对应第 6 周）

**问题**：完全没有评审流程。

改动：
1. 新增 `src/main/code-review.ts`：输入 diff，输出结构化评审（问题、位置、严重度）。
2. 复用 `growth-experiments.ts` 的隔离 worktree 与回滚，不让评审直接改主工作区。
3. 触发点：`/review` 命令与设置里的开关，默认关闭。
4. 测试：空 diff、单文件问题、严重度排序。

验收：
- `/review` 能对当前改动输出评审清单。
- 评审不修改工作区，失败可回滚。

产出：0.0.118。

## 阶段 5：技能生命周期（对应第 3 周）

**问题**：安装与检索已通，缺版本、依赖、回滚、效果评估。

改动：
1. `library-store.ts`：SKILL.md frontmatter 增加 `version`、`requires` 两个可选字段，非法值只告警不阻断。
2. 技能安装保留旧版本一份，支持一键回滚。
3. `library-health.ts` 增加技能可用性检查（依赖缺失、路径失效）。

验收：
- 装两个版本可来回切。
- 缺依赖时在库列表标黄并给出缺什么。

产出：0.0.119。

## 顺序与依赖

1 → 2 → 3 → 4 → 5。阶段 1、2 改动小、收益直接，优先做；阶段 3 依赖阶段 1 的成本读数；阶段 4 依赖阶段 3 的模型选择；阶段 5 独立，可并行提前。

每阶段完成后：跑全量测试、打包、重启验证，再进下一阶段。
