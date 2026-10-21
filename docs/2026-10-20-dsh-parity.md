# DSH 内核与旧 Claude 内核的能力对照（2026-10-20）

0.0.91 移除了 Claude 运行时，所有对话统一走 DSH ACP。旧内核的一些能力和工具在 DSH 里
换了名字或根本没有对应实现。本文记录逐项对照、本轮已经补上的部分，以及仍然存在、需要
在后续版本处理的差异。

## 一、工具对照

| 旧 Claude 工具 | DSH 工具 | 时间线标签 | 状态 |
| --- | --- | --- | --- |
| Read | `read` | 读取 | 一致 |
| Write | `write` | 写入 | 一致 |
| Edit / MultiEdit | `edit` | 编辑 | DSH 没有批量编辑，逐次编辑 |
| — | `read_image` | 读取图片 | DSH 新增，已补标签 |
| Glob / Grep | `glob` / `grep` | 查找文件 / 搜索 | 一致 |
| Bash | `pwsh`（Windows）/ `bash` | 执行命令 | `pwsh` 是 DSH 的 PowerShell 工具，等价旧 Bash；已补标签 |
| BashOutput / KillShell | `job_output` / `job_list` / `job_kill` | 读取后台输出 / 列出后台任务 / 终止后台任务 | 后台任务模型不同，已补标签 |
| Task | `subagent` / `subagent_fork` | 子代理 | 见第四节子代理差异 |
| TodoWrite | `todo_write` | 更新任务 | 一致 |
| TaskCreate/Update/Get/List | — | — | DSH 没有任务看板工具，`todo_write` 承担清单 |
| WebSearch / WebFetch | `web_search` / `web_fetch` | 联网搜索 / 抓取网页 | 可随联网开关整体移除 |
| mcp__deepseek__search/fetch | `mcp__pet__deepseek_search/fetch` | 网页搜索 / 抓取网页 | 由应用桥提供，可随开关移除 |
| AskUserQuestion | `ask_user_question` | 向你提问 | DSH 有，但宿主没有作答 UI；提示词要求改用文字提问 |
| EnterPlanMode / ExitPlanMode | —（app 层计划模式） | 进入计划模式 / 提交计划 | 见第三节 |
| Skill | `skill` | 调用技能 | 一致 |
| SlashCommand | `slashcommand` / DSH 命令 | 运行命令 | 部分一致 |
| LSP | — | 分析代码 | DSH base 没有 LSP 工具 |
| — | `workflow` | 编排工作流 | DSH 新增 |
| — | `send_message` / `list_agents` / `interrupt_agent` | 给伙伴发消息 / 列出子代理 / 中止子代理 | 子代理控制工具，已补标签 |
| — | `create_goal` / `get_goal` / `update_goal` | 设定目标 / 查看目标 / 更新目标 | DSH 原生目标由应用接管，提示词要求不要调用 |
| — | `present` / `cordis_inspect_*` | 展示 / 查看插件 / 查询插件 | DSH 宿主工具，已补标签 |

## 二、宿主能力对照

| 能力 | 旧 Claude 内核 | DSH 内核（本轮之后） |
| --- | --- | --- |
| 审批模式 | plan / acceptEdits / bypassPermissions | 手动审批 = `workspace-write` 沙箱 + 逐条询问；工作区写入 = `workspace-write` 自动放行；完全访问 = `danger-full-access`；自我进化 = 完全访问 + 应用授权 |
| 计划模式 | CLI 原生计划工具 + 只读 | 只读沙箱 + 拒绝写工具；模型仍能看到工具，但写入会被沙箱拒绝 |
| 联网搜索开关 | 从工具表移除 WebSearch/WebFetch | 写 home patch 禁用 `tool-web`，并让 pet MCP 桥不声明/拒绝搜索工具；下一轮生效 |
| 自动压缩阈值 | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 写 `compaction-basic.thresholdRatio`；下一轮生效 |
| 手动压缩 | `/compact` 与按钮 | **已支持**：ACP 补 `session/compact`，走 DSH 的 `compaction.compactNow`；没有可压缩内容时如实提示 |
| 输出风格 / 追加指令 | CLI 参数 | 拼进 DSH 系统提示，切换后下一轮重建进程 |
| 加载用户设置 | CLI flag | DSH 没有对应开关，保持无效（无副作用） |
| 插队发送 | 原生 steer | 原生 steer：补 `session/steer` 走 `agent.steer`，在下一步边界注入，不打断 |
| 子代理托盘 | SDK 提供 task_started、后台、停止、转达 | 用子代理工具调用生成任务；只显示状态/用时/摘要，后台、停止、转达按钮隐藏 |
| 目标模式 | CLI /goal | 应用层循环（`[[GOAL_DONE]]` 结束，轮数上限） |
| Token 用量 | SDK 逐轮给 | 读 DSH 会话日志（zstd 多帧）取差值 |

## 三、计划模式

宿主打开计划模式时，除了把沙箱切到 `read-only`，还通过补的 `session/plan` 调 DSH 的
`planMode.set(agent, true)`：模型会拿到计划提示和 `exit_plan_mode` 工具。提交计划时，
`exit_plan_mode` 走 `user-questions` 服务，ACP 的应答者把问题转成宿主提问面板
（`session/question`），用户选「批准」后答案直接回传，DSH 离开计划模式，宿主同步把
计划开关关掉。

限制：计划问题现在是通用提问面板，不是专门的计划预览页；没有 API Key 时只做了 mock
测试，未做真实计划模式联调。

## 四、子代理的边界

DSH 的子代理是独立会话：`session.header.parentSession` 指向父会话，`tool/call` 事件本身没有
父调用 id。ACP 补丁因此做了一层桥：

- 父会话里出现 `subagent` / `subagent_fork` 工具调用时，记下它的 `callId`；
- 收到 `parentSession` 指向该会话的子会话事件时，把 `tool/call`、`tool/result` 以
  `session/subagent_event` 推给宿主，带上父 `callId`；
- 宿主把这些事件挂到对应托盘任务的步骤里，托盘就能显示子代理内部跑了哪些工具。

限制：父调用是按“最近一个未结束的 subagent 调用”配对的，同一父代理并发开多个子代理时可能
配对错位。要精确配对，需要 DSH 在创建子代理时把父 `callId` 一起传下去（改 `dsh-tool-subagent`
的 activation 请求）。这台机器没有可用的 API Key，本轮只做了 mock 测试，未做真实子代理联调。

## 五、steer（插队发送）：已做成原生

DSH 的 ACP 规定同一会话同时只能有一个 prompt，所以单靠协议无法在中途插话。但 DSH 的 agent loop
本身有 `agent.steer(message)`，语义和 Claude 的 priority-'next' 一样：把消息插到当前回合的
下一步边界，不打断。

本项目给 vendor 里的 `dsh-acp` 补了一个自定义请求 `session/steer`：

- 宿主发 `session/steer`（sessionId + 文本/图片块）；
- DSH 侧走和 prompt 相同的准入逻辑（图片、文本校验），然后调用 `agent.steer(message)`；
- 模型在当前回合的下一步看到这句话，回复照常流式返回；
- 运行时没打补丁时，宿主自动退回“打断 + 立即投递”的旧路径。

补丁是 `scripts/patch-dsh-runtime.cjs`，幂等；`pack-release.ps1` 会在打包前自动跑一遍。
重装 `reference/dsh-runtime` 后也要重跑。

## 六、工具名与工具行显示

- 所有工具名都有中文标签，最多四个字；没登记的名字按关键词归类，MCP 统一显示“外部工具”，
  认不出的显示“工具”，时间线和忙碌提示不再出现英文标识。
- 工具行右侧信息由设置 → 外观 → 工具行信息控制：完整（参数 + 改动行数）、简略（默认，只留
  一小截参数）、仅名称。展开后的输入与输出始终完整。

## 七、开源与可组装

本项目把 DSH 当作开源运行时使用，改三处：

- `$DSH_HOME/cordis.patch.yml`：联网开关、压缩阈值这些运行配置；
- `scripts/patch-dsh-runtime.cjs`：给 vendor 的 `dsh-acp` 补 `session/steer`（打包前自动执行，幂等）；
- 本仓库的界面与宿主逻辑，改完执行 `npm run pack:release` 重新打包。

用户也可以自己往 profile 里加 Cordis 插件、往库里加 MCP 与技能。

图片输入已经接上：DSH 的 ACP 支持 image 块。4 MB 以内且模型声明多模态时内联；更大的图片按
文件引用发送（界面照常显示为图片，消息里给路径并提示用读图工具），附件上限 50 MB、预览 24 MB。

受 ACP 接口限制、还没做的：子代理父调用关系、询问作答界面。

## 八、ACP 是什么

ACP（Agent Client Protocol）是“编辑器/宿主 ↔ 编码代理”之间的一条 JSON-RPC 通道，跑在 stdio 上。
可以把它理解成“代理版的 LSP”：

- 宿主（本项目）启动 DSH 进程，发 `initialize` 握手，声明自己能提供什么（文件读写、终端、图片）。
- 宿主发 `session/new` 建会话，`session/prompt` 发一轮用户输入。
- DSH 反向推 `session/update` 通知：流式文本、思考、工具调用开始/结束、上下文用量。
- DSH 需要审批时发 `session/request_permission` 请求，宿主回“允许一次/拒绝”。
- 宿主可以 `session/cancel` 打断当前回合，`session/resume` 恢复历史会话。

标准协议只覆盖“对话 + 工具 + 权限 + 会话”这几件事。宿主想补能力有两条路：宿主侧模拟，或者给
DSH 的 ACP 桥加自定义方法。`session/steer` 就是后者：ACP 的 `onRequest` 支持自定义方法和
params 解析器，补上以后原生插队就能用了。

## 九、本轮验证

- `npm run check` 通过。
- `npm test`：870 项通过，24 项门控跳过。
- 新增：`test/dsh-web-policy.test.ts`、`test/dsh-subagent.test.ts`、`test/dsh-steer.test.ts`、
  `test/steer-interrupt.test.ts`、`test/panel-tool-row-dom.test.tsx`、`test/prompt-images.test.ts`。
- 用 `dsh --profile acp --dump-config` 确认 home 级补丁生效：
  `tool-web` 为 `disabled: true`，`compaction-basic.thresholdRatio` 与设置一致。
- 用临时 DSH_HOME 真实调用 `session/steer`，返回 `queued: true`。
- 0.0.92 已打包：`release/whale-companion-v0.0.92`，包内 `dsh-acp` 含 `session/steer`。

## 十、仍未做

1. 子代理内部工具的独立分组：ACP 的 `tool/call` 事件只有 `callId/name/arguments`，没有父调用 id。
   要做得改 DSH 的 ACP 桥，把子代理事件挂到父调用下（估计 1–2 天，含回归）。
2. DSH 的 `ask_user_question` 作答 UI：DSH 的 user-questions 插件没有 ACP 通道。要做得在 DSH 侧
   注册一个新的 ACP 请求（问题 + 选项），宿主弹面板作答再回传（估计 1–2 天）。
3. GUI 手动验收：菜单三项、插队发送、审批弹窗、联网开关的下一轮生效、切换对话回到底部、图片发送。
4. 手动压缩已按用户要求删掉按钮，只保留自动压缩，不再列入待办。
