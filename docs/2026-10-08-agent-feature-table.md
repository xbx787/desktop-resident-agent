# 桌面 Agent 基础功能表

目标：先把桌面角色变成可持续工作的本地 Agent，再进入人格、记忆和皮肤阶段。交互仍留在角色上方的同一气泡；用户负责可见界面验收。

会话库总数不限。“5”只表示放大气泡底部默认显示的快捷切换位数，可在选项里调为 1–12。归档保留记录，不影响创建新会话。

| 优先级 | 功能组 | 增加的能力 | 验收口径 |
| --- | --- | --- | --- |
| 0 | 视觉修整 | 提高悬浮输入按钮不透明度；右上角放大键把气泡向上撑到屏幕顶部、向左扩至 1.5 倍，保持角色屏幕位置 | 常态清晰可见；展开收起不挤占记录行；放大/还原时角色不跳动 |
| 1 | 会话库 | 新建、切换、自动标题、重命名、搜索、归档、恢复、明确删除；本地持久保存 | 重启后可找回记录；会话之间不串内容；归档不占上限 |
| 2 | 上下文续接与压缩 | 每个会话保留独立消息、任务状态与模型上下文；接 Agent SDK 原生 session 续接；上下文用量达到 70% 时自动 compact 并保留摘要 | 重启后继续旧话题；会话互不串内容；压缩后能引用重要既往信息 |
| 3 | 设置 | 快捷会话位默认 5、可调 1–12；闲置自动归档默认关闭、可设 7/14/30 天 | 设置重启后生效；会话库总数不限 |
| 4 | Agent 工作台 | 保留流式回复、文件附件；增加工具活动、文件引用、失败提示、任务记录；任务运行时输入为空显示停止，有文字显示发送；Enter 排队，Ctrl+Enter 直接介入当前任务 | 用户能看出 Agent 当前做了什么、结果是什么；队列与介入不会丢消息 |
| 5 | 桌面与语音 | 接入本机 Windows MCP，改进语音识别/朗读的打断和状态；保留当前用户指定的无逐次工具审批模式 | 桌面动作及结果进入会话；语音可边说边显示并可打断 |

实施顺序：先完成角色与气泡、无限会话库、原生 SDK 续接与阶段间引导，再完成 70% 上下文预算、工具活动、Windows MCP、文件与命令输入。随后加入 side chat、检查点、语音和人格与长期记忆。

当前进展：无限会话库、默认 5 个快捷位、原生阶段间引导、SDK session 续接、实测上下文用量、手动压缩与 70% 预算检查已接入预览版。会话数据放在项目内稳定的 `data/conversations`。真实短会话压缩会返回“不需要”；70% 长会话触发、Windows MCP 桌面动作和可见 UI 仍待验收。`@` 文件与 `/` 命令候选、原生角色/托盘右键菜单也已实现。

Claudian 参考：[项目 README](https://github.com/YishenTu/claudian/blob/main/README.md)、[会话浏览](https://github.com/YishenTu/claudian/blob/main/src/features/chat/session-manager/SessionBrowser.ts)、[会话操作](https://github.com/YishenTu/claudian/blob/main/src/features/chat/session-manager/SessionActions.ts)、[归档逻辑](https://github.com/YishenTu/claudian/blob/main/src/features/chat/conversation/InactiveSessionArchiver.ts)、[设置结构](https://github.com/YishenTu/claudian/blob/main/src/features/settings/ClaudianSettings.ts)。Claudia/Opcode 参考：[运行中的输入按钮](https://github.com/winfunc/opcode/blob/main/src/components/FloatingPromptInput.tsx)、[消息队列](https://github.com/winfunc/opcode/blob/main/src/components/claude-code-session/PromptQueue.tsx)。当前用户指定的“空输入停止、有内容发送”和 Ctrl+Enter 介入规则以本项目实现为准，不照搬它们。借鉴交互和功能拆分，不复制代码或素材。

## Claudian 深入对照后的下一步

| 优先级 | 能力 | Claudian 做法 | 本项目改造入口 |
| --- | --- | --- | --- |
| P0 | 原生持续会话流 | 长期存活的 Query + MessageChannel 支持同会话排队、优先介入与 interrupt；[源码](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/execution/ClaudeExecutionStrategies.ts#L65-L165) | 已实现；真实无界面两轮续接及 `priority:'next'` 引导通过 |
| P0 | 继承本机 MCP 和工作流 | 从 Claude Code 的 user/project/local 设置加载；[源码](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/settings.ts#L103-L109) | Windows MCP 已传入 SDK；真实技能/命令目录链接发现通过，Windows MCP 工具调用待验收 |
| P1 | 可核查的工具活动 | 实时渲染工具卡与调用结果；[源码](https://github.com/YishenTu/claudian/blob/main/src/features/chat/rendering/tools/ToolCallRenderer.ts#L27-L119) | 已接 SDK 结构化事件与可折叠时间线；复杂工具调用 UI 待验收 |
| P1 | 丰富输入上下文 | 图片、文件、选区及 `@` 引用；[源码](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts#L247-L275) | 文本附件、`@` 工作区文件已接模型；图片仅完成后端校验/编码模块，未接 UI/SDK 发送；选区与会话引用待做 |
| P2 | 轻量工作流与会话整理 | slash commands/skills、置顶和闲置自动归档；[README](https://github.com/YishenTu/claudian/blob/main/README.md#L20-L30)、[归档源码](https://github.com/YishenTu/claudian/blob/main/src/features/chat/conversation/InactiveSessionArchiver.ts#L5-L19) | `/` 候选、置顶和自动归档已实现；side chat/检查点待做 |

Claudian 是 Obsidian 插件，文件上下文、选区等围绕笔记库设计。本产品可把相同机制扩展为当前应用、窗口、文件和任务上下文。语音与桌面实体继续作为本产品的独立方向。
