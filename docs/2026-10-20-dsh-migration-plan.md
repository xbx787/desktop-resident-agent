# DSH 迁移计划（2026-10-20）

## 决定与目标

主人已决定：必须把 agent 内核从 Claude Agent SDK / Claude Code 迁移到 DeepSeek Harness（DSH），首要原因是无法规避潜在的法律与合规风险。目标是在保留现有 Electron / React 桌宠 UI、对话存储、审批、目标模式、子代理、压缩等行为的前提下替换内核。

迁移期间保留 `claude_code` 回退开关；在测试通过前不切换默认内核。

## 不可变约束

- 不改变总体 UI，不重做交互。
- 不删除或迁移用户对话数据。
- 不把 B 站自动化插件或账号工具引入主应用；迁移只针对 agent 内核。
- DSH 仍是 developer preview，必须锁定版本或 commit，记录升级门禁。
- 许可证合规：DSH（MIT）、DeepSeek API 条款、Claude/Anthropic 依赖的移除计划；不把 GPL 运行时代码静态分发。
- 只有当 `npm run check`、全量测试和真机冒烟都通过时，才切换默认内核。

## 现状耦合清单

- `src/main/claude-agent.ts`：`query()`、`resume`、`permissionMode`/`canUseTool`、hooks（PreCompact/PostCompact）、`includePartialMessages`、`maxTurns`、`mcpServers`、`plugins`、`settingSources`、上下文用量/压缩、计划模式、AskUserQuestion、子代理状态、错误分类、空闲释放。
- `src/main/agent-runtime.ts`：任务状态机、事件分发、队列、目标预算、审批、权限、计划、子代理、用量、重启恢复。
- `src/main/deepseek.ts`：`ModelClient` 已经是唯一的内核接缝；UI 不直接依赖 Claude SDK 类型。
- 工具：`conversation-tools`、`deepseek-tools`、`evolve-tools`（进程内 MCP）。
- 持久化：`ConversationRecord`（mode、timeline、history、sdkSessionId、goal、approvalMode、pendingMessages）。
- 侧聊：与主对话共用 runtime 工厂。
- 打包：`@anthropic-ai/claude-agent-sdk` + 打包内的 `claude.exe`。

## 目标架构

新增内部协议 `AgentKernel`，`AgentRuntime` 只依赖它：

```
runTurn(input) -> async iterable events
  assistant / thinking / tool-start / tool-end / permission / usage /
  compaction / subagent / plan / goal / error / done
resume(sessionId)
interrupt()
setApprovalMode(mode)
setPlanMode(on)
compact()
setMcpServers(servers)
dispose()
```

- `ClaudeKernel`：包装现有 `ClaudeAgentClient`，行为不变，作为回退。
- `DshKernel`：用 `@deepseek-ai/dsh-agent-loop` 或 `dsh-sdk-minimal` 实现同一协议。
- `AgentRuntime` 改为依赖 `AgentKernel`；模型/provider 配置仍走 DeepSeek Anthropic 兼容端点或 DSH 原生适配器。
- 工具层不变：继续通过 MCP 注入 `deepseek`、`conversations`、`evolve`。

## 阶段与验收

### Phase 0：法务与基线（半天）

- 审计 Claude Agent SDK / Claude Code 的许可、使用条款与分发限制；列出必须移除的依赖与时机。
- 确认 DSH 版本/commit、MIT 许可证、官方嵌入文档；记录到本文件。
- 建立 `data/dsh-migration/state.json` 和进度日志。
- 验收：法务清单、版本锁定、回退开关设计写入文档。

### Phase 1：内核接口抽象（1–2 天）

- 定义 `AgentKernel` 类型与事件；实现 `ClaudeKernel` 适配器。
- `AgentRuntime` 切到 `AgentKernel`，不改 UI 和持久化。
- 验收：`npm run check`、全量测试、构建通过；现有对话行为不变。

### Phase 2：DSH PoC（2–3 天）

- 在独立目录（如 `reference/dsh-poc/` 或 `src/main/dsh/`）安装锁定版本的 DSH；不改主依赖树。
- 跑通：创建会话、发送消息、流式事件、工具调用、中断、恢复。
- 对照现有 UI 需要的事件，列出差距清单（权限、计划、子代理、压缩、用量、目标）。
- 验收：PoC 可运行；差距清单写入 state.json。

### Phase 3：DshKernel 适配器（3–5 天）

- 实现 `DshKernel`，映射事件、审批、计划、子代理、压缩、用量、目标。
- 注入 MCP 工具服务器；保留工具白名单和权限边界。
- 设置里增加灰度开关（默认 `claude_code`）；单测 + mock 集成测试。
- 验收：check/test/build；灰度对话可用。

### Phase 4：端到端与切换（3–5 天）

- 用 DSH 跑真实对话：普通回答、工具、审批、计划、目标、压缩、子代理、重启恢复。
- 修复差距，记录性能与成本；真机冒烟。
- 默认切换到 DSH，保留 Claude 回退；需要打包时单独确认。
- 验收：全量测试 + 真机冒烟 + 回退验证。

### Phase 5：清理（1–2 天）

- 把 Claude SDK 依赖改为可选或移除；更新 README、许可、NOTICE。
- 验收：无必需 Claude 运行时依赖；DSH 默认可用。

## 自动执行规则

- 从 Phase 0 开始按顺序推进；每阶段完成更新 `data/dsh-migration/state.json`（phase、status、evidence、next）。
- 每步运行 `npm run check` 和相关测试；失败先修，不跳过。
- 遇到 DSH API 不确定：读本地包类型、官方源码/文档，做最小实验，记录结论后再改。
- 不询问用户，不等待确认；自主审批、修改、运行和调整方向。
- 不改变总体 UI；不引入 B 站自动化；不删除用户数据。
- 上下文接近压缩或需要重启时，用 `evolve.schedule` 把下一步写入任务文件，再 `evolve.restart`；最多 10 次。
- 只有全量测试通过才切换默认内核；保留 `claude_code` 回退。
- 计划完成时把 `data/evolve/task.json` 的 status 改为 done，并在聊天里汇报。

## 风险与回退

- DSH 预览期 breaking changes：锁定版本/commit，升级前跑回归。
- 事件语义差异：先 PoC，再适配；不直接替换主链路。
- 桌面版插件兼容：只依赖 agent-loop/SDK 包，不依赖 DSH 桌面 UI。
- 法务：DSH MIT；DeepSeek API 条款；移除 Anthropic 依赖；AI 内容标识。
- 回退：`claude_code` 与 `dsh` 并存至少一个版本。

## 进度

- Phase 0：完成（法务与版本锁定）。
- Phase 1：完成（AgentKernel 接缝）。
- Phase 2：完成（pnpm 运行时 PoC，工具调用通过）。
- Phase 3：完成（DshAgentClient、灰度 env/设置、真实会话测试）。
- Phase 4：完成（打包运行时验证，默认切换 DSH，Claude 回退保留）。
- Phase 5：基本完成（文档与回退说明）；审批/计划/目标/子代理/应用内 MCP 对等留作后续。

## ACP 宿主增强（2026-10-20 后续）

参考社区 DSH Desktop 的“完整运行时 + 原生宿主”思路，默认 DSH 传输从 `sdk-minimal` 切到 `acp`：

- 新增 `src/main/dsh-acp-runtime.ts`：标准 ACP v1 的 JSON-RPC 客户端，支持 `initialize`、`session/new`、`session/resume`、`session/prompt`、`session/cancel`、`session/close`、`session/update`、`session/request_permission` 和 server→client 请求。
- 新增 `src/main/dsh-acp-agent.ts`：把 ACP 的助手消息、思考、工具生命周期、上下文用量映射到 `ModelClient`；权限请求按审批模式决定自动允许、拒绝或交给面板确认。
- 新增 `src/main/pet-mcp-server.ts` + `scripts/pet-mcp-bridge.cjs`：ACP `session/new` 直接声明一个 stdio MCP 服务，桥接主进程的对话、自我进化和 DeepSeek 搜索工具。
- 目标模式：没有原生 goal 的内核（DSH）改由 `AgentRuntime` 本地循环，`[[GOAL_DONE]]` 结束，轮数上限与 `/goal clear` 保留。
- 回退：`DESKTOP_PET_DSH_TRANSPORT=sdk-minimal` 仍可使用精简协议；Claude Code 回退不变。

验证：`test/dsh-acp.live.test.ts` 六项真实测试通过（文本、工具、跨运行时会话恢复、取消后继续、库 MCP 注入、应用内 MCP）；全量测试通过；`npm run check` 与 `npm run build` 通过。

## 与 DSH 桌面端融合（2026-10-20 第二轮）

- **审批模式改为 DSH 的沙箱预设**：`read-only` / `workspace-write` / `danger-full-access`，加上应用自己的 `selfEvolve`。切换时把 `DSH_PERMISSION_MODE` 写入子进程环境；运行中切换只记录，下一轮重启 DSH 后生效，不打断当前任务。Claude 回退把三档映射到 `plan` / `acceptEdits` / `bypassPermissions`；自我进化在两侧都保持最高档，不会被内核回报降级。
- **token 明细**：ACP 不提供逐轮 input/output，但 DSH 的持久化日志 `assistant/message.data.usage` 有完整计数。新增 `src/main/dsh-session-log.ts`，不依赖外部库地遍历 Zstandard 多帧日志，按会话累计，每轮取差值上报；`test/dsh-session-log.test.ts` 覆盖多帧、未压缩、损坏和回退。
- **库注入**：MCP 库经 `toAcpMcpServer()` 转成 ACP 声明（stdio 解析 PATH 到绝对路径，HTTP 直接声明）；技能库和插件里的 `skills/` 由 `src/main/dsh-skills.ts` 复制到 `$DSH_HOME/skills`，用 `.pet-managed.json` 只清理应用写过的条目。库变化会重建 DSH 会话。
- **桌面端能力对齐**：会话跨重启恢复、取消、上下文用量、插件/技能、MCP 市场、托盘/通知/自更新沿用现有应用能力。未检索到名为 “DeepSeek Carina Desktop” 的公开项目；融合按 DSH 官方桌面端与 DSH Desktop 的共同宿主能力执行。
- **体积**：`claude-agent-sdk-win32-x64` 中 `claude.exe` 为 244 MB；完整 DSH 运行时为 528 MB。移除 Claude 后包体减少 244 MB，但若原样打包 DSH，总包约 987 MB（当前 0.0.89 为 703 MB）。要真正变小，需要裁剪 DSH 运行时（删除未用插件、多平台二进制和开发依赖），这是下一步独立工作。

已知差距：逐工具审批取决于 DSH 的 `approval/ask` 策略，普通读写不会逐条弹窗；计划模式在 DSH 下是应用层的只读映射，不能强制阻止 DSH 原生写工具；ACP 不支持计划/模式/命令/终端扩展；图片 prompt 不支持；人设切换需重启 DSH；Claude 插件中的 commands/hooks 无法注入 DSH，只同步其 skills；DSH 子代理有工具但未在 UI 单独成组。

## 去 Claude 与运行时裁剪（2026-10-20 第三轮）

用户确认「DeepSeek Carina Desktop」是语音识别错误，目标项目就是《DeepSeek Harness Desktop》。已将 `https://github.com/anywhere-labs/deepseek-harness-desktop` 浅克隆到 `reference/dsh-desktop`（442 MB，4565 个文件）并对照源码，而不是只看搜索摘要。

### DSH Desktop 的实际实现

- `dsh-desktop-next` 是 Electron Host，加载官方 Web 前端；`dsh-desktop-next/cordis.patch.yml` 把桌面能力作为 Cordis bundle 插入完整 `dsh-base`/Web profile，不是 ACP 或 SDK 客户端。
- `dsh-desktop-next/src/backend-controller.ts` 用 `DesktopBackendController` 串行化启动/停止/重试，失败先清理子进程；`src/host-process.ts` 用 Electron Node 模式启动 Host，通过 IPC 接收 `ready`/`fatal`/权限/通知事件。
- Host 使用认证 HTTP + WebSocket（`127.0.0.1` 随机端口），主进程保管 cookie 和每次启动生成的访问凭据；官方前端通过 `dsh-app://app` 加载，普通浏览器访问可关闭。
- 审批、计划、插件管理、Agent Teams、会话/用量看板来自 DSH 自己的 Web 客户端插件（`dsh-client-ui-approval`、`dsh-plan-mode`、`dsh-session-stats` 等），不是 ACP 暴露的接口。
- 运行时裁剪由 `scripts/prepare-payload.ts`、`scripts/runtime-file-policy.ts` 完成：按 Node 解析复制生产依赖闭包，排除 source map、TypeScript 声明、构建缓存、包管理器元数据、其他平台原生二进制和测试夹具；`vendor/dsh-runtime/0.2.1-rc.2` 的官方 tarball 集合只有 25 MB。

### 本项目的选择

- 不套 DSH Web GUI，继续用 ACP 承载完整 `dsh-base`，保留小鲸现有 UI。
- 借鉴 `DesktopBackendController` 的边界：DSH 子进程失败/退出时清理 pending 请求，应用退出统一释放。
- 把 `nextRuntimeFileExclusion` 的思路用于 `resources/dsh`：排除 LibreOffice、Sherpa、Inspector、Web 前端/客户端 UI、Anthropic/OpenAI/Google 适配器、`.map`/`.d.ts`/`.tsbuildinfo`。
- 新包移除 Claude：生产依赖、`build.files` 和主进程接线都不再包含 `@anthropic-ai/claude-agent-sdk`/`claude.exe`；`claude_code` 只作为旧记录模式名保留。
- 体积：DSH 运行时 528 MB → 148 MB；安装目录 703 MB → 604 MB。
- 打包验证：Electron Node 模式启动裁剪后的 DSH ACP 完成文本回合；同一模式启动 `pet-mcp-bridge.cjs`，`mcp__pet__conversations_list` 调用成功。

### 仍待验收

- 0.0.91 GUI 启动、审批弹窗、目标模式、库注入和退出清理的真机行为。
- DSH Web 插件（计划/Agent Teams）与 ACP 的能力差距；ACP 不支持 plans/modes/commands/terminals。
- Cordis 插件安装/卸载接入应用插件库。
- 子代理 UI 分组与图片 prompt 桥接。
