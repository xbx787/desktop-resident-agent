# 设置项差距盘点（2026-10-19）

对比对象：`reference/claudian` 的 `ClaudianSettings` 通用设置与 `ClaudeSettingsTab`（Claude Code provider 设置页）。只补适合 Windows 桌面客户端的缺失功能，不照搬 Obsidian 专有项。

## 本来就有

| 类别 | 已有设置 |
| --- | --- |
| 会话 | 顶部快捷标签数、闲置自动归档、目标轮数/时长上限、标题自动生成、消息时间戳 |
| 模型 | 模型配置增删改、API Key 加密、端点、小模型、模型级环境变量、连接测试、思考强度 |
| Claude | 权限模式、上下文压缩阈值、联网搜索开关、人设、临时会话 |
| 外观 | 界面字号、人物大小、面板尺寸 |
| 内容 | 记忆开关与记忆编辑、人设切换、称呼与头像 |
| 扩展 | MCP / 技能 / 插件库与市场 |
| 语音 | SiliconFlow Key、音色、语速、自动朗读、文档转音频 |

## 本轮补齐

| 设置 | 作用 | 落点 |
| --- | --- | --- |
| 回答风格 `outputStyle` | 使用 Claude Code 的 default / Explanatory / Learning；自定义风格保留 | 设置 → 对话；SDK `outputStyle` |
| 附加指令 `appendSystemPrompt` | 追加在人设之后；改变时丢弃记录了旧 system prompt 的 SDK 会话 | 设置 → 对话；SDK `systemPrompt.append` |
| 加载用户设置 `loadUserSettings` | 是否把 `user` 加入 `settingSources`；关闭后不读 `~/.claude` | 设置 → 对话；SDK `settingSources` |
| 自动跟随 `autoScroll` | 关闭后新内容不再自动滚底；回到底部键仍可用 | 设置 → 对话；面板滚动 effect |
| 默认展开编辑 `expandFileEditsByDefault` | Edit / Write / MultiEdit 行首次渲染即展开 | 设置 → 对话；工具行 `details` |
| 会话排序 `sessionSort` | 最近更新或创建时间；置顶始终优先 | 设置 → 对话；会话库排序 |
| 标题语言 `titleLocale` | auto 跟随消息语言，或固定中文/英文 | 设置 → 对话；标题生成指令 |
| 标题模型 `titleModel` | `deepseek-flash` 或 `deepseek-chat` | 设置 → 对话；标题生成请求 |

## 有意不做

- **CLI 安装路径 / provider 启用 / Chrome 集成**：桌面版内置 SDK，没有外部 CLI 安装概念；Claude in Chrome 不适用于本产品。
- **Obsidian 专有项**：笔记排除标签、附件媒体目录、聊天视图位置、Zen 模式、双栏、Linked content 恢复。本应用没有 Vault。
- **界面语言切换**：当前 UI 只有中文，做完整 i18n 是独立工程，不在本轮范围。
- **键盘导航（w/s/i）**：桌面聊天气泡不适合 vim 式滚动；保留现有方向键与滚轮。
- **隐藏命令**：当前内置命令数量少，隐藏列表的维护成本高于收益。
- **环境变量片段**：模型配置已有 `extraEnv`，再叠加全局片段会引入密钥存储和覆盖顺序问题，暂不增加。
- **模型级自定义上下文窗口**：需要同时改上下文计量和压缩预算，等有明确的自定义模型需求再做。
- **提示建议（promptSuggestions）**：需要额外的模型调用与输入建议 UI，属于独立功能。

## 验证

- 设置持久化：新增字段写入、重开库读取、空值清除与非法值拒绝均有测试。
- SDK 链路：`outputStyle` 和 `systemPrompt.append` 出现在 query options；`settingSources` 随开关变化。
- 标题生成：语言指令随 locale 切换，auto 按消息语言选择中/英；模型名进入请求体。
- 全量测试通过，类型检查与生产构建通过。
