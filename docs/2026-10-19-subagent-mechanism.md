# 子代理机制优化（2026-10-19）

参考 `reference/claudian` 最新版的 `SubagentManager`、`SubagentStreamRouter` 和异步子代理恢复逻辑，本轮只调整主进程的状态机，不改子代理图标、浮层和操作入口。

## 借鉴点

Claudian 把子代理分成同步（阻塞当前轮）和异步（后台运行）两类，并为每个任务维护独立生命周期：

- 任务工具调用可能先到，输入或模式尚未确定时先缓冲；后续分片到达再决议。
- 异步完成通知可能早于任务记录到达，Claudian 用有上限的 deferred completion 缓存，等任务出现后合并。
- 每个任务只接受一次终态，终态来源区分 notification / tool output / local error，避免重复通知互相覆盖。
- 流结束或会话重置时调用 `orphanAllActive()`，把没有收尾的活动任务交还并标记。
- 子代理自己的工具调用按 id 合并，进度只更新仍在运行的任务。
- 待机 / 后台 / 停止的清理都是显式生命周期方法，定时器和缓存有上限。

## 本项目的实现

`src/main/claude-agent.ts` 保持原有 `SubagentTask` 契约和 `setSubagentTasksListener` 接口：

1. **乱序事件缓存**
   - `deferredSubagentEvents`：`task_progress` / `task_updated` / `task_notification` 找不到任务时按 `task_id` 缓存，`task_started` 到达后按到达顺序回放。
   - `deferredSubagentFrames`：`parent_tool_use_id` 还没有对应任务时缓存子消息帧，任务绑定 `tool_use_id` 后回放。
   - 每个任务最多 20 条事件，每个父工具最多 30 帧，两个 map 最多 64 个键；超出丢弃最旧的键。

2. **终态不可逆**
   - 已终态任务忽略迟到的 `task_progress`；`task_updated` 的 `running` 补丁不能复活终态任务。
   - 重复的 `task_started` 只更新仍存在的字段，保留已有 usage、时间线和 `startedAt`。
   - 重复的 `task_notification` 幂等：状态相同则只更新摘要，保留第一次的 `endedAt`。

3. **中断兜底**
   - `finishTurn` 在错误或人工中断时调用 `orphanForegroundSubagents()`，把 `running` 且非后台的前台任务标为 `stopped`，摘要写明「随本轮结束，未收到完成通知」。
   - 兜底状态记录在 `orphanedSubagents`；之后真正的完成通知仍可覆盖它，不会把成功任务永久误标为停止。
   - 正常收到 result 时不触碰运行中的任务，后台子代理继续工作。

4. **现有节流与清理保持不变**
   - 启动、终态和字段补丁立即发布；进度最多每 2 秒发布一次。
   - 完成任务在主进程保留 30 秒、渲染层再保留 6 秒，随后移除。
   - 查询关闭时清空任务、映射和所有 deferred 缓存。

## 未采用的部分

- **异步 AgentOutput 回读**：Claudian 面向多家 provider，需要 `AgentOutput` 工具读取后台任务结果。当前只接 Claude Agent SDK，Task 工具结果已经进入主时间线，没有额外回读层。
- **增量流路由**：Claudian 的 `SubagentStreamRouter` 把子代理的流式增量路由到对应卡片。本轮仍使用 SDK 的完整子消息（`forwardSubagentText`），避免在浮层里引入高频增量重绘；后续如果需要逐字显示，再按 `parent_tool_use_id` 接 `stream_event`。
- **跨重启历史恢复**：Claudian 会从持久化数据恢复异步子代理卡片。当前子代理详情是内存快照，会话重启后只保留主时间线里的 Task 工具行；恢复需要把 `SubagentTask` 写入会话记录，属于下一步的存储改动。
- **多 provider 结果解释器**：当前只有一套 SDK 事件语义，不需要 provider adapter。

## 验证

新增五条回归测试覆盖：先到进度与完成通知、先到子消息帧、终态抗迟到更新、流失败时的前台任务收尾、重复 `task_started` 的字段合并。全量测试通过。
