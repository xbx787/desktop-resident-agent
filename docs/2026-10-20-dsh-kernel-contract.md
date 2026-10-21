# AgentKernel 契约（Phase 1）

`src/main/agent-kernel.ts` 把现有 `ModelClient` 明确标记为内核接缝。`AgentRuntime`、对话存储和 UI 都只依赖这一层；Claude Code 与 DSH 各自实现同一份回调契约。

## 一次回合

```ts
respond(
  history, signal,
  onProgress(text, segment),
  sdkSessionId,
  onToolEvent({ toolUseId, toolName, phase, input, output, images, isError }),
  onTaskUsage(usage),
  onThinking(text, segment)
): Promise<ModelReply>
```

| 现有字段 | DSH 映射目标 |
| --- | --- |
| `history`（user/assistant 文本 + sessionContext） | DSH session 历史 / 初始化消息 |
| `signal` | `agent.cancel()` / AbortSignal |
| `onProgress` | assistant 流式文本 |
| `sdkSessionId` | DSH `sessionId` / resume id |
| `onToolEvent.start/result` | tool call / tool result 事件 |
| `onTaskUsage` | usage / token 统计 |
| `onThinking` | reasoning delta |
| `ModelReply.text` | 最终 assistant 文本 |
| `ModelReply.interrupted` | 取消结束 |
| `ModelReply.compacted` | compaction 事件 |

## 可选控制面

| 能力 | Claude 实现 | DSH 迁移要求 |
| --- | --- | --- |
| `setApprovalMode` | `permissionMode` / `setPermissionMode` | 映射 DSH 权限策略；selfEvolve 仍只在应用层 |
| `setPlanMode` | 计划模式 | 用 system prompt / 工具集模拟或 DSH 原生机制 |
| `setPermissionListener` / `answerPermission` | `canUseTool` 挂起 | DSH 工具审批事件 |
| `setQuestionListener` / `answerQuestion` | AskUserQuestion | DSH 交互工具或应用层提示 |
| `setPlanListener` / `answerPlan` | ExitPlanMode | 应用层计划审批 |
| `setGoalListener` | `/goal` 事件 | DSH 目标/停止钩子或应用层模拟 |
| `setSubagentTasksListener` | Task 子代理 | DSH subagent/agent 树 |
| `setCompactingListener` | Pre/PostCompact hooks | DSH compaction 事件 |
| `interrupt` | CLI Esc | DSH `agent.cancel()` |

## 迁移原则

1. UI、`ConversationRecord`、`AgentRuntime` 不导入 `@deepseek-ai/*` 类型。
2. `ClaudeAgentClient` 保持原行为，作为回退；`DshAgentClient` 逐项实现，缺项明确降级而不是静默丢事件。
3. 只有 `respond` 与事件映射通过真实任务验收后，才把默认内核切到 DSH。
4. 记录 DSH JSON-RPC 的实际字段到 `docs/2026-10-20-dsh-poc.md`，避免凭文档猜协议。

## Phase 1 验收

- `AgentKernel` 类型已建立，`AgentRuntime` 使用它。
- 现有 `ClaudeAgentClient` 仍实现同一契约，行为不变。
- 类型检查、全量测试、构建通过。
