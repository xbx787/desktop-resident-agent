# Claudian 借鉴清单（2026-10-10）

来源：`reference/claudian` 完整源码调研（5 路并行）。目的：把成熟产品做得好的地方加进 Whale Companion。
状态约定：待评估 → 已采纳（待做）→ 已完成 / 不适用。

## 一、执行内核与进程管理（agent 调研完成）

| # | 亮点 | 位置 | 做法 | 适配性 | 状态 |
| --- | --- | --- | --- | --- | --- |
| K1 | GUI 增强 PATH 与 CLI 定位 | `core/process/env.ts:39-194,266-315`、`core/process/cliBinaryLocator.ts:29-57`、`providers/claude/runtime/ClaudeBinaryLocator.ts:141-178` | 显式枚举 nvm-windows/volta/fnm/scoop/choco/mise/npm 全局目录拼增强 PATH 注入子进程；Windows 只认 `.exe` 或 Node 入口，跳过 POSIX shim | **直接可用**——我们 findClaudeExecutable 只有 2 个候选路径 | ✅ 已完成 |
| K2 | Windows cmd shim 与进程树终止 | `core/process/windowsCmdShim.ts:22-76`、`providers/claude/runtime/customSpawn.ts:75-93` | `.cmd` 启动时 kill 用 `taskkill /pid /t /f` 杀整棵树；包装 child.kill 让调用方无感 | 直接可用（若出现停止残留进程） | 待评估 |
| K3 | 跨 realm AbortSignal 的 spawn 封装 | `providers/claude/runtime/customSpawn.ts:14-72` | 不把 AbortSignal 直传 spawn（Electron 跨 realm instanceof 失败），手动 addEventListener；shebang 探测归一化为 `node <script>` | 直接可用（走 SDK spawnClaudeCodeProcess 注入） | 待评估 |
| K4 | 双执行策略 + 配置指纹重启 | `providers/claude/execution/ClaudeExecutionStrategies.ts:71-504` | `restartKey` JSON 指纹决定换进程 vs 热更新（setModel/setPermissionMode）；同 session 串行 | 需适配（指纹扩到代理端口/BASE_URL/model） | 待做 |
| K5 | steer 投递确认与撤回语义 | `ClaudeTurnInputs.ts:13-96`、`ClaudeExecutionStrategies.ts:131-178`、`core/execution/RewindableExecutionSession.ts:31-45` | 每条输入带 UUID，`user_message_uuids` 判定送达；未投递 steer 的取消必须换进程而非 interrupt；只有「确定未交接」才能 resolve(false) | 直接可用（修「停止后排队消息丢失/重复」） | 待做 |
| K6 | 取消后的迟到事件围栏 | `ClaudeExecutionSession.ts:123-124,241-247,457-468,644-651,677-690` | cancel 时把该 turn 的 token 放进 suppressed 集合，迟到消息/失败直接吞掉（新 run 接手时转交） | 直接可用（防「停止后界面被顶起来」竞态） | 待做 |
| K7 | 错误分类 → 会话失效语义 | `classifyClaudeError.ts:28-117` | 类型化信号 + 文本兜底分类（authentication/configuration/transport/process-exited/session-missing）；从「no conversation found」提取 sessionId 校验；分类映射到是否清 resume | 直接可用（DeepSeek 代理掉线给准确提示） | ✅ 已完成 |
| K8 | resume 状态机与历史重放代际 | `ClaudeResumeState.ts:17-146` | 检测 sessionId 漂移 → 记 previousIds + historyReplayPending → 下一回合重放本地历史；代际防误清 | 需适配（自动压缩/重启丢上下文场景） | 待评估 |
| K9 | 运行时指纹变化 → 会话作废 | `ClaudeSettingsReconciler.ts:20-22,93-113`、`CachedProviderCLIResolver.ts` | env（BASE_URL/PATH/model/HOME）+ CLI 路径做指纹；不匹配则会话不可 resume；**缓存永不缓存失败** | 需适配 | 待做 |
| K10 | 多后端统一执行契约 | `core/execution/ProviderExecutionBackend.ts` 等 | 单终态事件流 + 提前 break 即取消 + 事件信封带 sequence/turnId | 需适配（若接第二后端） | 待评估 |
| K11 | provider 级代际围栏与静默过渡 | `ProviderExecutionLifecycleRegistry.ts:210-390` | generation + 租约；过渡自增使 lease 失效并 dispose；过渡期新请求 fail-fast retryable | 需适配（简化版替手工重启） | 待评估 |
| K12 | 交互挂起账本与审批路由 | `PendingInteractionLedger.ts:44-122`、`ClaudeExecutionInteractionRouter.ts:26-200` | 每次 canUseTool 登记互动 id；响应回显校验、stale 判 deny+interrupt；dispose 时 dismissAll；AskUserQuestion 自动补 isOther | 直接可用（消灭「回答早已失效的审批」） | 待做 |
| K13 | 安全：元数据 id 与设备键 | `core/bootstrap/storagePaths.ts:11-36`、`core/device/InstallationKey.ts:9-97` | 会话 id 过 SAFE_METADATA_ID_PATTERN（防路径穿越）；设备键先写后读回校验 | 直接可用 | 待评估 |
| K14 | JSON-RPC 行协议 | `core/rpc/JSONRPCTransport.ts:115-418` | 30s 超时 + AbortSignal；dispose 全量 reject；streamCloseGraceMs 半关闭宽限 | 暂存（loopback 代理控制通道可用） | 待评估 |

补充（低成本）：`ProcessProbe.ts:4-45`（有界探测 5s/16KB/finally shutdown）；`probeClaudeRuntime.ts:16-135`（30s 上限、MCP_TIMEOUT=5000、等 init 再读 commands）；`loadClaudeAgentSDK.ts:5-10`（SDK 动态 import 免启动期加载）。

## 二、输入与交互（agent 调研完成）

| # | 亮点 | 位置 | 做法 | 适配性 | 状态 |
| --- | --- | --- | --- | --- | --- |
| I1 | 下拉候选加载生命周期 | `shared/composer-dropdown/ComposerDropdownController.ts:171-243` | 单调 generation + 每请求 AbortController + 200ms 防抖；Loading/空/错误三态文案；键盘跳过 status 项；接受时吞多余空格防双空格 | 直接可用（我们 @文件//命令候选加 generation 校验与三态） | 待做 |
| I2 | chip 化 token 编辑语义 | `composer/ComposerEditor.ts:99-114,149-163,324-337` | 四条互锁规则：未完成 token 保持可编辑；chip 整块 Backspace 删除；光标落入 chip 露出原始 Markdown | 需适配（大：需 CodeMirror；暂缓） | 暂缓 |
| I3 | 失败即恢复的草稿治理 | `composer/ComposerDraftController.ts:39-48`、`input/InputController.ts:358-430`、`SubmissionPreparations.ts:17-25` | 草稿按目的地停放、发送前 consume；所有失败路径统一 restore(merge)；主目的地用 reserveMainAdmission 屏障串行化准备；准备期 aria-busy | 直接可用（同场景：异步准备期间切会话不能丢/重） | 待做 |
| I4 | 工具栏菜单焦点/键盘模型 | `composer/toolbar/ToolbarMenu.ts:39-62,187-309` | 同屏至多一菜单；Escape 挂 window 捕获并 stopPropagation（抢在宿主 keymap 取消 turn 之前）；Tab 关菜单还焦点；重建后按 data-menu-key 恢复 | 直接可用（对叠全局 Esc=停止 的 Electron 直接相关） | 待做 |
| I5 | @提及排序与 token 守卫 | `shared/composer-dropdown/MentionSource.ts:119-205,63-77` | 前缀命中 → mtime 新优先 → 类型 → 名字；目录 mtime 聚合；已完成的 @token 不再触发；`\@` 转义 | 直接可用（候选排序四两拨千斤） | 待做 |
| I6 | 消息引用浮动按钮 | `chat/input/MessageQuoteController.ts:14-180` | 选中文本浮出引用按钮；mousedown preventDefault 保选区；点击时重取选区；逐行 `>` 拼接 + 光标落位 | 直接可用（新功能：引用历史消息） | 待评估 |
| I7 | 档位滑块的提交纪律 | `composer/toolbar/EffortSelector.ts:81-99,139-195` | input 只动视觉、change 才提交；dragging/pendingCommits 期间拒外部回写；scaleKey 防重建 | 直接可用（检查我们 effort 滑块是否拖拽途中就发请求） | 待做 |
| I8 | 异步提问一次性投递 | `chat/interactions/asyncQuestionDelivery.ts:24-59`、`AsyncQuestionPrompts.ts:52-66` | accepted/not-sent/uncertain 三态；仅明确 not-sent 才降级；uncertain 显式提示不重发；取消只中止已提交的 | 需适配（小）——提问/审批回调同场景 | 待做 |
| I9 | 内联交互抑制栈 | `chat/interactions/InlineInteractionPrompts.ts:178-235` | suppressDepth 引用计数；同 id 重复 reject；abort/异常路径摘除恢复；身份比较防陈旧 resolve | 直接可用（多层交互并存层级管理） | 待评估 |
| I10 | chip 托盘实测溢出折叠 | `composer/ComposerContextTray.ts:91-142,233-252` | rAF 按 offsetTop 1px 容差归并行，只留 1 行；「+N more」自身不越界；ResizeObserver 驱动 | 直接可用（附件行溢出） | 待做 |
| I11 | 附件拖放竞态与边界 | `composer/ImageContextManager.ts:172-285` | attachmentGeneration 令牌作废在途读取；dragleave 几何确认不闪烁；粘贴挂 capture 阶段；扩展名表优先 MIME | 直接可用（我们已有拖拽/粘贴，补竞态） | 待做 |
| I12 | 幽灵文本建议抑制与 IME | `composer/ComposerPromptSuggestion.ts:27-89` | 建议绑定 turnId 复核；输入为空、非 IME、无 aria-expanded 弹层才显示；MutationObserver 监听 | 需适配（中）——未来功能 | 暂缓 |
| I13 | 选择上下文移交宽限期 | `input/SelectionController.ts:10,30-38,308-377` | 1500ms 宽限期不清上下文；镜像高亮；轮询独立 try/catch；提交快照深拷贝 | 需适配/不适用（无编辑器）；深拷贝保险可吸收 | 暂缓 |
| I14 | 文件索引 SWR 缓存 | `shared/mention/VaultMentionCache.ts:37-50`、`VaultMentionDataProvider.ts:19-45` | dirty + setTimeout(0) 预热；刷新失败保留旧数据且已有数据时停止重试；create/delete/rename 分级失效 | 直接可用（我们的文件候选） | 待做 |

补充：`ContextUsageMeter.ts:76-103`（progressbar aria + 80% 警告 + /compact 提示——若没有上下文条可吸收；我们已有，略）。

## 三、渲染与内联编辑（agent 调研完成）

> 注意：调研澄清——Claudian **没有**词级 diff。它的内联编辑预览是「行级 LCS + 前后两份完整 Markdown 各自渲染对比」（R3），是对 Markdown 的取舍（词级源码 diff 会把表格/代码块砍半截）。

| # | 亮点 | 位置 | 做法 | 适配性 | 状态 |
| --- | --- | --- | --- | --- | --- |
| R1 | Inline Edit 安全应用：源快照+陈旧拒收 | `features/inline-edit/ui/InlineEditModal.ts:440-464,888-1004` | 打开时存 doc 快照；apply 前校验 doc 身份+区间+文本三重一致，不符整体 reject；generation 丢弃换代后迟到结果 | 直接可用（若做内联编辑/应用到编辑区） | 待评估 |
| R2 | Inline Edit 原地预览：选区被 widget 替换+草稿保活 | 同文件 `:113-150,539-661,828-869` | CM6 StateField 三种装饰态；widget 销毁时把 input 值存回草稿、重建回填；预览内 Accept/Reject 带 role=toolbar | 需适配（不用 CM6 需自建 overlay） | 暂缓 |
| R3 | diff 预览：行级 LCS → 两份完整 Markdown 渲染对比 | 同文件 `:161-244,674-682`、`style/features/inline-edit.css:197-223` | 改动拼出「旧文档」「新文档」两份合法 Markdown 分别渲染，红/绿块对比 | 需适配（可取思路：大幅改动双块对比兜底） | 待评估 |
| R4 | 流式渲染节流协调器 | `features/chat/turns/StreamingRenderCoordinator.ts:48-186`、`StreamController.ts:52,124-125` | 只留最新快照+version 计数；rAF 调度；下次间隔=clamp(渲染耗时×2,150,500)；flush() 强制穿透并 await 到该版本 | 直接可用（强化我们 50ms 快照合帧） | 待做 |
| R5 | 流式中 KaTeX 延迟渲染：转义 `$` 直到最终帧 | `rendering/markdown/MarkdownContentRenderer.ts:19-70`、`utils/markdownMath.ts:85-100` | 流式期间 math 分隔符转义按纯文本显示，结束帧 final 重渲染上 KaTeX；Mermaid 全程延迟；fence 语言临时占位防半截代码块高亮 | 直接可用（我们有 KaTeX，流式半截 `$` 会乱） | ✅ 已完成 |
| R6 | 工具卡惰性渲染 + WeakMap 快照替换 | `rendering/tools/ToolCallRenderer.ts:26-99`、`WriteEditRenderer.ts:113-213` | 内容只在展开时渲染；流式更新只置 dirty；历史回放 onFirstExpand 才渲染；WeakMap 按元素存 update 函数 | 直接可用（我们时间线的折叠卡） | 待做 |
| R7 | 按工具的表现层表 + 三态（pending/空/状态） | `rendering/tools/toolPresentation.ts:71-318` 等 | 每工具声明表 ~25 个；Bash 展开显 `$ command`；TodoWrite 名「Tasks 3/5」+ activeForm；apply_patch 状态位换 `+N -M`；空结果占位统一决策；aria 从表自动生成 | 直接可用（照表重构工具渲染） | 待做 |
| R8 | Markdown 渲染作用域 + isCurrent 守卫 | `rendering/markdown/MarkdownRenderScope.ts:4-29`、`MarkdownContentRenderer.ts:44-106` | 每元素一个 scope；重渲染前释放旧 scope；每个 await 后检查 isCurrent；MutationObserver 只对移除子树释放 | 需适配（概念通用） | 待评估 |
| R9 | 折叠/展开无障碍成体系 | `rendering/collapsible.ts:23-115`、`style/accessibility.css:4-34` | 非原生 header 获 role=button/tabindex/Enter+Space/aria-expanded；统一 focus-visible；reduced-motion 关 spinner；禁用按钮用 aria-description 说明原因 | 直接可用 | 待做 |
| R10 | IME 与全局键盘监听作用域守卫 | `InlineEditModal.ts:484-490,875-884,1016-1041` | Esc/Enter 处理显式跳过 `e.isComposing`；document 级监听用 isKeyboardEventInContext 限定 target 范围 | 直接可用（中文用户刚需） | 待做 |
| R11 | 不可信 Markdown 的转义顺序 | `rendering/markdown/markdownHTML.ts:11-17` | 先转义模型输出原始 HTML，再注入可信标记；顺序注释固定 | 直接可用（安全底线） | 待做 |
| R12 | Inline Edit 会话所有权与生命周期 | `inline-edit/InlineEditSessionOwner.ts:6-17`、`InlineEditEditorLifetime.ts:5-23`、`InlineEditModal.ts:293-362` | 单会话准入（关旧拒新）；编辑器销毁自动 close；settled 单次结算；provider 未初始化先初始化失败给 Notice | 需适配 | 暂缓 |
| R13 | 内联编辑上下文：@解析+选区漂移跟随+失败重试 | `InlineEditModal.ts:518-537,815-826,1043-1072`、`contextMentionResolver.ts:46-80` | 指令内 `@路径` 发送时解析（长到短试切+去尾标点+Windows 不敏感）；生成期间跟随重选区；失败重锚定可重试 | 需适配 | 暂缓 |
| R14 | 边界处理合集 | `providerOutputChunks.ts:13-19`（空 delta 丢弃）、`MessageRenderer.ts:345-349,584-593`（空白块跳过；滚动仅贴底 100px 才跟随）、`DiffRenderer.ts:23-106`（hunk 前后 3 行、新建文件截 20 行、无变更「No changes」） | 逐条的流式/大输出对策 | 直接可用 | 待做 |

补充：Thinking 块计时标签「Thinking Ns...」→ 收尾「Thought for Ns」+ 自动折叠（`ThinkingBlockRenderer.ts:35-85`）；Mermaid 安全渲染（SVG→data-URI img + 查看源码切换 + 出错回退源码，`MermaidRenderer.ts:36-92`）。

---

## 五路汇总统计

| 模块 | 项数 | 其中「直接可用」 |
| --- | --- | --- |
| 一、执行内核 | 14 | 6 |
| 二、输入与交互 | 14 | 7 |
| 三、渲染与内联编辑 | 14 | 8 |
| 四、会话与状态管理 | 13 | 10 |
| 五、提示/技能/基础层 | 13 | 7 |
| **合计** | **68** | **38** |

---

## 实施进展

**第一批（2026-10-10，完成 5/5）**：

1. ✅ **P1+P11 会话标题自动生成** —— 新增 `src/main/title-generation.ts`（首句兜底本来就有；补上后台 DeepSeek 生成 + 清洗装饰 + 手改防覆盖 + 20s 超时静默失败），`conversation-controller.refineTitle` 只在标题仍是 fallback 时写回。
2. ✅ **K1 增强 PATH + CLI 定位** —— `claude-code.ts` 新增 `extraBinaryPaths`/`enhancedPath`（npm/`.local/bin`/volta/bun/scoop/pnpm/chocolatey/nodejs/Git bash），CLI 定位枚举这些位置找 `claude.exe`、跳过 `.cmd` shim；子进程 PATH 一并增强（打包版从快捷方式启动也能找到 CLI 与 bash）。
3. ✅ **K7 错误分类** —— 新增 `src/main/agent-errors.ts`（session-missing 带 id 提取 / authentication / transport / process-exited / configuration / unknown），`AgentTurnError` 跨层传递；runtime 在会话失效时清 `sdkSessionId` 并给出准确提示（「连接 DeepSeek 失败」「认证失败」不再淹没为「运行失败」）。
4. ✅ **R5 KaTeX 流式转义** —— `MessageMarkdown` 新增 `streaming`：流式期间 math 按纯文本，回合定稿后才渲染 KaTeX；`TimelineItem` 接通 `running`（memo 比较同步带上，防最后一帧被吞）。
5. ✅ **P5 历史压缩分级** —— `boundedConversation` 重做：整行优先 → 旧行压缩到 600B（保留开头）→ 再超则丢弃并在头部加「（更早的 N 条消息因篇幅省略）」标注；UTF-8 边界安全切割。

验证：`npm run check` ✓；全量 **239 通过 / 9 跳过**（+23）。

**第二批（2026-10-10，完成 4 实做 + 5 核验）**：

1. ✅ **I4 Esc 捕获竞争修复**（发现真实问题）——任务运行中开着模型菜单/会话菜单/候选时按 Esc 会被全局捕获直接停任务；现在弹层优先吃 Esc（先关弹层、再按才停），两个菜单补 Esc 关闭。
2. ✅ **I7 effort 滑块提交纪律**——抽出 `EffortSlider`：拖拽中只动视觉（draft），释放（原生 change）才提交；保存回来才交出控制权。
3. ✅ **I1 候选三态**——`@`/`/` 候选补「没有匹配内容」「查找失败，继续输入可重试」，不再静默消失。
4. ✅ **S3 空闲释放**——CLI query 闲置 30 分钟自动关闭省资源；session id 保留、下条消息自动重建续接。
5. ➖ 核验不适用/已具备：K5/K6 停止语义（已具备，+防回归测试）、S13 用量合并（单模型架构不存在错配）、P13 设置去抖（已有 draft+提交纪律）、P12 路径（附件落盘已有 UUID+过滤防护）、S2 删除墓碑（副本提交模型天然回滚 + id 不复用）。

**第三批（2026-10-10，完成 3 实做 + 3 核验）**：

1. ✅ **P3 提示词漂移清理**——删除 `claude-code.ts` 中已死的旧 stream-json 路径（-97 行：`ClaudeStreamParser`/`ClaudeCodeClient`/与现行不一致的旧 PERSONA）；基础人格本就由 `persona.ts` 单一权威 + 各通道 section 拼装，架构上已符合 P3。
2. ✅ **I5 文件候选排序**——「前缀命中 → 最近修改优先 → 路径序」；刚编辑过的文件浮上来。
3. ✅ **R6 工具卡惰性**——diff 的 LCS 用 `useMemo` 按 input 缓存（流式帧不再每帧重算）；卡片正文首次展开才挂载 DOM。
4. ➖ 核验：R9 折叠无障碍（全用原生 details，已具备）、P2 XML 包装（纯文本协议无多层转义，+ 已有「数据非指令」声明）、R14 边界合集（滚动贴底跟随/截断标注已有）。
5. 🔧 顺手加固一条时间敏感测试（cancellation fencing 改轮询等待）。

**第四批（2026-10-10，完成 1 实做 + 3 核验）**：

1. ✅ **I6 消息引用**（新功能）——在消息流里选中文字浮出「引用」按钮，点击把选中内容以 markdown 引用（逐行 `>`）放进输入框并聚焦落尾。防护：mousedown preventDefault 保选区、按钮自身 stopPropagation 防被清、滚动即隐、空选不串。
2. ➖ 核验：I3 发送失败草稿恢复（已具备：`send()` 未接受时恢复草稿/附件且不覆盖新输入）、I10 附件行溢出（上限 5 个 + 横向滚动，无需折叠）、I11 附件预览竞态（渲染条件依赖 attachments 列表，清空后不显示陈旧预览）。

**四批累计**：实做 17 项（含 2 个新功能与 1 个真实 bug 修复），核验「已具备/不适用」22 项；全量测试从 216 → **249 通过**。

## 四、会话与状态管理（agent 调研完成）

| # | 亮点 | 位置 | 做法 | 适配性 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S1 | 单一权威仓库 + generation 栅栏 + 每会话串行写队列 | `app/conversations/ConversationRepository.ts:83-140,835-848,1187-1248` | 唯一可变权威 recordsById，对外发 detached 克隆；每会话 promise 链串行写盘；异步读 await 后用 generation 复验，过期丢弃 | 直接可用（消灭「慢读回来覆盖新数据」） | 待做 |
| S2 | 可回滚两阶段删除 + 删除墓碑 | `ConversationRepository.ts:389-468`、`ConversationExecutionBindings.ts:106-128` | 删除先内存移除记录，删文件失败插回原位并重放未落盘快照；墓碑拒绝已删 id 复活（防 SDK 续接拉回） | 直接可用 | 待做 |
| S3 | 30 分钟空闲释放 provider 会话 | `tabs/runtime/TabRuntimeShell.ts:184,232-240`、`execution/ChatExecutionCoordinator.ts:139-760` | 每次活动重置计时；释放要求无 turn/交互/pending steer/后台工作；释放前先持久化最新快照；generation 校验防过期释放 | 直接可用（省资源不丢现场） | 待做 |
| S4 | 版本化快照整体拒绝损坏 | `core/bootstrap/tabManagerState.ts:25-104`、`SessionStorage.ts:73-102` | 版本号/重复 id/字段冲突任一不满足整体返回 null；宽松解码只许用于一次性迁移 | 直接可用（JSON 持久化缺这层） | 待做 |
| S5 | 防抖 + 已确认序列化对比持久化协调器 | `tabs/persistence/TabStatePersistenceCoordinator.ts:19-88` | stringify 与已落盘对比相同即跳过；300ms 防抖；写入循环追最新；flush 可被 shutdown 等待 | 直接可用（替换直接 writeFile） | 待做 |
| S6 | 退出协议：drain → flush → seal | `TabWorkspaceLifecycle.ts:124-132,204-261`、`TabManager.ts:1060-1114` | beginShutdown 暂停新准入并取消前台；drain 依次 join 所有队列；flush 后 seal 身份；同实例重开用已封存快照 | 需适配（Electron before-quit 替代；协议照搬） | 待做 |
| S7 | 懒加载 + 后台分批扫描 + 未解析 shell 回收 | `SessionMetadataLoader.ts:50-298`、`SessionStorage.ts:105-213` | 首批 16 条边读边发布（列表秒开）；mtime+size 复验跳过重解析；后台失败则撤回 shell | 直接可用 | 待做 |
| S8 | 归档在串行化写入点重新校验谓词 | `ConversationRepository.ts:579-591`、`InactiveSessionArchiver.ts:44-78` | archiveIf(ids, predicate) 在写锁内重执行谓词（被置顶/打开自动豁免）；触发串行 | 直接可用（后台任务与用户操作竞态） | 待做 |
| S9 | 恢复只建 shell 不起执行 | `TabManager.ts:903-964`、`SessionNavigation.ts:82-171` | restoreState 只落 shell 壳、最后激活一个；持久化只存身份不存草稿/消息/DOM；预览标签失焦即回收 | 直接可用（重启不拉起一堆 CLI） | 待做 |
| S10 | 原子写 + realpath 路径围栏 | `core/storage/VaultFileAdapter.ts:240-474`、`pathContainment.ts:28-47` | 写 `.tmp`（wx 独占）再 rename；逐段 lstat 拒 symlink/junction、realpath 校验不逃逸根 | 直接可用（Windows 两高频事故源） | 待做 |
| S11 | 临时快照放系统 tmp + 权限断言 + 定时清扫 | `app/conversations/SessionSnapshotStore.ts:12-52` | 快照写 os.tmpdir，目录 0700/文件 0600 wx；写前 assertSafeDirectory；启动异步扫 7 天清理 | 直接可用 | 待评估 |
| S12 | Side Chat：纯内存子会话（fork seed 语义） | `side-chat/SideChatSession.ts:79-408`、`SideChatRuntime.ts:378-381` 等 | 每会话至多一个 side；不落盘不写 tab 状态；seed 只用父 fork 源不带父 sessionId；native 上下文丢即作废不重建；父切换即 discard | 需适配（新功能候选；两条铁律照搬） | 待评估 |
| S13 | 用量合并守卫：不混用两模型 token 与窗口 | `state/usageInfo.ts:63-95` | 新报告无窗口时同模型沿用、换模型整份保留旧报告直到新完整报告 | 直接可用（我们已有用量显示） | 待做 |

补充：归档「应用是真相源、provider 原生归档只镜像」（`ConversationService.ts:94-109`、`NativeSessionArchiveSync.ts:20-72`）；迁移纪律「旧快照 claim-once、新格式写成功才删旧、flush 失败保留待重试」（`TabWorkspaceLifecycle.restore:306-354`）。

## 五、提示、技能与基础层（agent 调研完成）

| # | 亮点 | 位置 | 做法 | 适配性 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P1 | 会话标题自动生成全流程 | `features/chat/conversation/ConversationTitleGeneration.ts`、`core/prompt/titleGeneration.ts:4-71`、`core/auxiliary/TitleGenerationService.ts:29-81` | 首条消息即用「首句截 50 字符」fallback（界面永不 Untitled），后台异步生成不阻塞；完成时比对 expectedTitle（用户已改名则放弃）；forbidden 前缀、输入截 500、输出去引号截 50；每会话一个 ActiveGeneration 新请求取消旧请求 | 直接可用（**新功能**：会话自动命名） | ✅ 已完成 |
| P2 | XML 上下文包装 + 恰好解码一次契约 | `core/prompt/promptXML.ts:16-30`、`mainAgent.ts:27-43`、`promptContext.ts:25-45` | 属性转义含 XML 非法码点→U+FFFD、`\t\n\r`→字符引用；系统提示里声明标签 schema + 「属性必须恰好解码一次」契约防二次解码 | 直接可用（本地上下文/附件注入） | 待做 |
| P3 | 系统提示词 = 可组合 section 数组 | `core/prompt/mainAgent.ts:8-103` | 七个 section 函数 filter(Boolean).join，空段消失；Custom Instructions 放最后；主会话不注入日期而是让模型跑 `date`（"Never guess"） | 直接可用（persona.ts 改为 section 之一） | 待做 |
| P4 | 提交时快照（capture-at-submit） | `core/prompt/promptContext.ts:148-162`、`core/types/chat.ts:74-79` | 提交瞬间深拷贝全部上下文挂到消息上；历史重建用快照原样重建；配套 extractUserDisplayContent 从 XML 前切出干净显示文本 | 直接可用（所见即所发可审计） | 待做 |
| P5 | 历史重建的行级压缩预算 | `core/prompt/historyContext.ts:19-92,106-123,224-248` | 按信息价值分级：tool input 截 100/200、对象压 `[object]`、工具调用单行、**成功结果丢弃、失败结果保留截 500**、thinking 压成块数+时长摘要、图片压成清单 | 直接可用（强化我们 boundedConversation） | ✅ 已完成 |
| P6 | slash 命令：单分词器+能力门控+三来源同构 | `core/commands/builtInCommands.ts:104-208`、`slashCommand.ts:3-18` | 全应用唯一 parseLeadingBuiltInCommand；内建命令声明 requiredCapability 按 provider 过滤；内建/用户/技能投影成同构条目；参数提示自动包 `[ ]` | 需适配（换命令集；三结构照搬） | 待评估 |
| P7 | 技能/命令文件仓库：乐观锁+串行写队列 | `features/agent-skills/AgentSkillRepository.ts:71-196`、`utils/concurrency.ts:4-30` | revision=sha256、不匹配抛冲突；mutationQueue 串行化；失败回滚（删文件→删空目录）；list 逐项 try/catch 降级为 diagnostics；mapWithConcurrency(8) 限流 | 需适配（若做用户可编辑技能文件；mapWithConcurrency 可先取） | 暂缓 |
| P8 | Frontmatter 容错解析 + slug 校验 | `features/agent-skills/frontmatter.ts:38-194` | YAML 抛错回退逐行解析（救「值带冒号」）；拒绝 YAML 1.1 保留词（true/false/yes/no/on/off）做名字；严格/宽松双解析 | 需适配（若做技能文件） | 暂缓 |
| P9 | i18n 类型化 key + 懒加载 | `i18n/types.ts:5-15`、`i18n.ts:26-140` | LeafKeys 模板字面量从 en.json 推导全部 key（写错即编译失败）；只有 en 静态 import 其余 require 懒加载；缺失回退英文再回退 key | 不适用（当前仅中文）；将来多语言时照搬 | 暂缓 |
| P10 | 性能预算双轨 + 急切副作用检测 | `scripts/check-startup-performance.mjs:10-197`、`core/performance/StartupProfiler.ts:50-158` | bundle 体积硬线 + 模块求值毫秒中位数警告；子进程 monkeypatch 检测「模块求值期出现 spawn/listen/WASM」直接报错；profiler freeze 后零开销 | 需适配（阈值换我们的）；**eager spawn 检测思路直接可用** | 待评估 |
| P11 | 辅助会话控制器：generation+租约+失效即取消 | `core/auxiliary/AuxiliarySessionController.ts:20-139`、`TextResponseCollector.ts:17-56` | 辅助任务独立 ephemeral 租约；start/cancel/dispose 递增 generation，回调先验代际；只认 turn_completed 终结，半截输出绝不成功 | 直接可用（标题生成等辅助任务骨架） | 待做 |
| P12 | Windows/Git-Bash 路径工具集 | `utils/path.ts:36-255` | `%VAR%`/`!VAR!`/`$env:VAR`/`$VAR` 全展开；MSYS `/c/...` → `C:\...`（须在 resolve 前）；resolveRealPath 向上找最近存在祖先；比较时小写归一；`isPathWithinDirectory` 双侧 realpath 防符号链接逃逸 | 直接可用（Windows 优先场景必备） | 待做 |
| P13 | 设置：按键去抖文本写入器 | `shared/settings/DebouncedSettingsWriter.ts:1-32`、`features/settings/ClaudianSettings.ts:53-57,158,225-234` | 文本设置按 key 存 pending，单 500ms 定时器事务性 flush；切页/重渲染前强制 flush；generation+dispose 防已销毁面板重绘落地 | 直接可用（设置窗口输入） | 待做 |
