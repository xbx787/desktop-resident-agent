# DSH 桌面端能力融合矩阵（2026-10-20）

用户要求把 DSH base 与 DeepSeek Carina Desktop（DSH Desktop）充分融合。公开渠道没有检索到名为 “DeepSeek Carina Desktop” 的独立项目；本文件按 DSH 官方桌面端（`apps/desktop`）与社区 DSH Desktop 的共同宿主能力逐项对照，记录小鲸已经落地、明确差距和后续动作。

## 原则

- 不套 DSH Web GUI，不改变小鲸现有 UI。
- 使用 DSH 官方 `acp` profile 承载完整 `dsh-base`，而不是精简的 `sdk-minimal`。
- 桌面端只做宿主：进程生命周期、会话、审批、用量、库、通知；模型和工具仍由 DSH 提供。
- 所有能力有测试或明确标注差距，不把「看起来像」当成已实现。

## 对照表

| 能力 | DSH base / 桌面端做法 | 小鲸实现 | 状态 |
|---|---|---|---|
| 完整运行时 | 内置 DSH 运行时与 Node | `resources/dsh` 打包 pnpm 运行时 | 已做 |
| 会话 | ACP `session/new`、`session/resume`、`session/close` | `DshAcpRuntime` + `DshAcpAgentClient`；应用重启后按 `sdkSessionId` resume | 已做，live 测试覆盖 |
| 审批 | `read-only` / `workspace-write` / `danger-full-access` + `ask/never` | 同名三档 + 应用自己的 `selfEvolve`；`DSH_PERMISSION_MODE` 进程级生效 | 已做，只读写文件测试覆盖 |
| 取消 | ACP `session/cancel` | abort 时发送 cancel，prompt 返回 `cancelled`，会话可继续 | 已做，live 测试覆盖 |
| MCP | 插件式 MCP client，stdio/HTTP | 应用库转 ACP 声明；stdio 解析 PATH，坏条目跳过；HTTP 支持 | 已做 |
| 技能 | `$DSH_HOME/skills`、项目 `.dsh/skills` | 技能库与插件 `skills/` 同步到 `$DSH_HOME/skills`，受管清单清理 | 已做 |
| 插件 | Cordis 插件、插件市场 | Claude 插件只同步 skills；Cordis 插件需要 `dsh plugin add` | 部分；差距 |
| 上下文用量 | `usage_update` | 映射到 `ContextUsageSnapshot` | 已做 |
| 计费 token | 会话日志 `assistant/message.data.usage` | `dsh-session-log` 解析 Zstandard 多帧，按轮差值上报 | 已做，单元测试覆盖 |
| 子代理 | `dsh-tool-subagent`、Agent Teams | DSH 工具可用，ACP 只暴露通用工具生命周期 | 机制在，UI 未分组 |
| 计划模式 | 桌面端 Web 计划卡片 | ACP 不支持 modes/plans；应用把计划映射为只读档 | 差距 |
| 图片 prompt | 桌面端支持图片 | ACP `promptCapabilities.image=false` | 差距 |
| 文件预览/diff | 桌面端右侧 diff | 工具结果以文本展示，未做 diff 视图 | 未做，不改变 UI |
| 托盘/通知/自更新 | 桌面壳提供 | 小鲸已有托盘、通知、自检、重启 | 已有 |
| 定时任务 | Automation Task 插件 | 应用 `inbox` + Windows 计划任务 + headless | 已有 |
| 体积 | 内置运行时 | claude.exe 244 MB + DSH 528 MB | 需要裁剪 |

## 体积结论

- `@anthropic-ai/claude-agent-sdk-win32-x64` 内的 `claude.exe` 为 244 MB。
- 完整 DSH 运行时为 528 MB。
- 当前 0.0.89 安装目录为 703 MB（包含 claude.exe，不含 DSH）。
- 保留 `claude_code` 回退时，两个运行时都要分发；移除 Claude 后包体少 244 MB，但 DSH 完整运行时更大，原样打包约 987 MB。
- 要真正变小，必须裁剪 DSH 运行时：按 profile 的实际依赖删除未使用的插件包、非 Windows 原生二进制、source map、文档和测试夹具；这是独立工作，不能只靠删 claude.exe。

## 后续

1. DSH 运行时裁剪与打包体积基准。
2. Cordis 插件安装/卸载接入应用插件库。
3. 子代理 UI 分组（不改变总体布局）。
4. ACP 图片 prompt 的替代方案（图片先落盘，以文本/资源链接传递）。
5. 若用户提供 Carina Desktop 的仓库地址，按本表补充对照。
