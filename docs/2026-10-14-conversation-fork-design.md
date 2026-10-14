# 从最新回复创建独立会话：实现设计

> 状态：方案，尚未交付。依据小鲸 v0.0.52 源码与项目内 `reference/claudian`。本功能只分叉对话记录，不回滚电脑上的文件。

## 能力边界

Claudian 的持久 fork 会取得原生 assistant checkpoint 和源 session ID，将 `forkSource: { sessionId, resumeAt }` 交给对应 provider；Claude SDK 首轮带 `forkSession: true`，成功后形成新的原生 session。它的 side chat 则是另一个**只在内存中存在**的临时子运行时，不写会话库。参见 `reference/claudian/src/features/chat/tabs/forking/ForkSource.ts`、`ForkTarget.ts`、`providers/claude/history/ClaudeConversationHistoryService.ts` 与 `features/chat/side-chat/AGENTS.md`。

小鲸目前只保存可见 `timeline`、模型 `history` 和整段 `sdkSessionId`，未保存回复对应的原生 checkpoint。把旧 `sdkSessionId` 填给子会话只会复用原会话，不能当作 fork。因此首版应命名为**「从最新回复复制会话续聊」**：复制已保存的对话，在新会话首次发送时从历史冷重放；原会话仍可继续。Claude 冷重放受 `boundedConversation` 字节预算约束，DeepSeek 仅取最近 20 条模型消息；模型不能保证记得全部旧工具过程。界面提示应如实说明这个限制。

## 首版状态与数据契约

1. 入口只针对最新一条**已完成、非空**的 assistant 回复。客户端传 `sourceConversationId` 和 `expectedAssistantEntryId`，主进程自己读取内容；绝不接受客户端提供的历史副本。源会话须未归档，`taskStatus === 'done'`，无运行任务、drain、待发送消息或待审批操作。冷会话也要检查磁盘记录中的 `pendingMessages`，不能只检查内存队列。最后一个 user 之后必须有目标最终回复，`history` 末行也须是 assistant；失败、取消或流式半截回复不能分叉。
2. `ConversationController.forkConversation(...)` 在现有 `serialize` 链中检查运行时和来源，必要时先持久化已完成运行时，再把预期回复 ID 交给 store 复核。异步等待后重新检查目标 ID 和状态；若源已继续执行，返回可见错误，不生成空白子会话。只有创建成功才切换显示；当前草稿仍归原会话。
3. `ConversationStore.forkConversation(...)` 使用现有 `mutate` 做**单次原子落盘**：生成新 UUID、时间戳、短标题和独立标签，深拷贝源的全部 `timeline` 与 `history`（含仅主进程使用的 `sessionContext`），继承 `mode`。新记录的 `sdkSessionId = null`、`taskStatus = 'idle'`、`pendingMessages = []`、`goal = null`、`archivedAt = pinnedAt = null`；不继承旧压缩摘要和运行状态。将新 ID 加入 `tabOrder` 并设为当前会话。旧时间线中的附件路径、工具结果只供显示，不复制文件或重放工具。源会话和子会话的数组与对象不得共享引用；删除源会话不删除子会话。
4. `PetAPI`、preload 和 `pet:fork-conversation` IPC 只传两个 ID，并沿用 `trusted(event)` 校验；响应只需新会话 ID/更新后快照，不能回传私有 `sessionContext`、模型密钥或整段存储记录。若未来显示「源自某会话」，只存可选来源元数据，来源不存在时子会话照常可用。

## 测试与交付判据

- Store：生成记录与标签的原子性、原会话不变、深拷贝隔离、重启后可读、删除来源后子会话可继续、磁盘写失败无半成品。
- Controller：空白、归档、运行中、排队中、审批中、失败、取消、陈旧回复 ID 均拒绝；完成回复通过；fork 与新发送并发时按序确定，不丢草稿或队列。
- 模型/IPC：子会话首次发送不带原 `sdkSessionId`；Claude 进入有界冷重放，DeepSeek 遵守最近 20 条；`sessionContext` 存在于主进程历史但不泄到 IPC；源与子会话各自后续发送互不串线。
- UI：只在合格回复显示入口；明确「复制历史续聊」，不称原生 checkpoint fork，也不暗示文件状态回退。可见界面由用户点击验收。

## 后续原生 checkpoint 条件

若要达到 Claudian 的原生 fork，需先从 SDK 事件取得最终 assistant 的稳定 checkpoint ID，持久映射到对应时间线条目；为 provider 定义 fork 能力与 `pendingFork { sourceSessionId, resumeAt }` 状态；新子会话首轮以 `forkSession: true` 启动，并在 SDK 返回**不同于来源**的新 session ID 后才确认为原生分支。失败时保留来源和子会话的可恢复状态，不得静默退化成共用原 session。文件回滚属于另一项需审阅差异的功能，不能由对话 fork 自动触发。
