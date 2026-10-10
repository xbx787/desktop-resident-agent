# Claudian 对照与桌面 Agent 实施标准

## 产品边界

鲸鱼娘是同一桌面智能体的实体入口。角色、聊天、会话库和设置共享一套状态；界面保持一块蓝色透明气泡。Claudian 的 Obsidian 宿主代码不直接移入 Electron；复用 Claude Agent SDK、现有 Claude Code 配置、本机 MCP 定义，以及 Claudian 已验证的会话与输入行为。

## P0：可靠的执行内核

| 能力 | 完成标准 |
| --- | --- |
| 原生持续流 | 每个活跃会话使用可持续输入的 SDK Query；Enter 排队，Ctrl+Enter 用 `priority:'next'` 在下一执行阶段介入，停止调用原生 interrupt；进程重启后可恢复 SDK session。参考 [Claudian 执行策略](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/execution/ClaudeExecutionStrategies.ts)。 |
| 上下文预算 | SDK 可用时展示实测 token/百分比；发送前计入用户输入、输出及工具保留量。预计触及 70% 时先压缩并重新取样；预算不足时阻止发送、保留草稿，明确提示。手动压缩按钮可用；不可读时显示“未知”，不伪造百分比。参考 [SDK 持续输入与上下文接口](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。 |
| 本机 MCP | 只读加载现有 Claude Code 配置中的 Windows MCP，作为 SDK MCP 服务启用并显示连接状态；不复制密钥或修改用户配置。可用工具不再被六个基础工具白名单限制。参考 [Claudian 配置来源](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/settings.ts)。 |
| 会话库 | 总数不限；旧数据迁移不丢消息/队列/SDK ID；置顶、重命名、归档、恢复、删除、搜索；自动归档默认关闭，可选 7/14/30 天，排除当前、置顶及待发会话。参考 [Claudian 会话操作](https://github.com/YishenTu/claudian/blob/main/src/features/chat/session-manager/SessionActions.ts)。 |

## P1：可观察、可输入的任务界面

1. SDK 工具开始、结果、错误保存为结构化时间线，展示折叠卡片；执行中的活动可见，结束后可回看。参考 [Claudian ToolCallRenderer](https://github.com/YishenTu/claudian/blob/main/src/features/chat/rendering/tools/ToolCallRenderer.ts)。
2. 图片粘贴/拖放、文本文件、`@` 文件/目录/会话引用可进入模型上下文；附件有大小和类型校验，发送失败不丢草稿。参考 [Claudian RequestEncoder](https://github.com/YishenTu/claudian/blob/main/src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts)。
3. 界面按 [UI 工程标准](./2026-10-08-ui-standard.md) 实现：放大态底部默认 5 个快捷会话位，和会话库总数无关；图标、tooltip、Windows 顺序的放大/关闭、右键选项、上下文环和压缩弹层均有真实行为。

## P2：可复用工作流

1. 从现有 Claude Code 设置发现 slash commands 与 skills，输入 `/`、`$` 时给出选择和说明；保留其原有作用域与解析顺序。参考 [Claudian README](https://github.com/YishenTu/claudian/blob/main/README.md)。
2. 临时 side chat 不改变主会话上下文；可选择并入摘要。文件变更提供可回看的检查点或差异，恢复动作需明确选择目标版本。参考 [Claudian Side Chat 与会话管理](https://github.com/YishenTu/claudian/blob/main/README.md)。
3. 工具失败、断线和压缩失败在当前会话给出可操作的重试/新会话入口，不能仅写控制台日志。

## P3：桌面能力与扩展

1. Windows MCP 的屏幕/窗口操作与文件/命令工具进入同一任务时间线，能区分模型计划、工具动作、观察结果和最终答复。
2. 增加其他 Agent provider 时沿用相同会话/工具/上下文契约；Claude Code 经 DeepSeek 转接是首个实现。参考 [Claudian provider 架构](https://github.com/YishenTu/claudian/blob/main/README.md)。
3. 语音与人格化是桌面角色的独立能力；此轮移除录音按钮，后台保留，后续再设计合适入口。

## 无界面验收门槛

TypeScript 检查、关键状态迁移与排队测试、真实 SDK 的持续会话/上下文读数/工具调用测试、打包文件磁盘核查。可见窗口的点击、布局、动画和拖动由用户逐项验收。
