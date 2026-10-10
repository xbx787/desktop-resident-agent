# 小鲸 · 桌面常驻智能体

一个住在 Windows 桌面上的鲸鱼少女智能体：角色常驻通知区域与桌面角落，点开就是完整的对话气泡。底层是 Claude Agent SDK（可接入任意 Anthropic 兼容厂商），能自主使用本机文件与命令工具完成真实工作。

仓库地址：<https://github.com/xbx787/desktop-resident-agent>。逐版更新见 [CHANGELOG.md](./CHANGELOG.md)。

## 功能亮点

- **对话气泡**：消息、思考链、工具活动共用一个时间线。一段回复被思考打断成多段时收成一个消息块（头像与时间只出现一次），每个片段如同无序列表。
- **消息刻度导航条**：气泡左缘一列刻度，悬停展开；滚轮翻动窗口，Dock 式弧形高亮，点击跳转到对应消息。
- **多厂商模型配置**：设置窗口里管理模型（DeepSeek / Kimi / 智谱 GLM / 自定义），密钥明文保存在本地数据目录，测试连接一键可用。
- **图片全流程**：发送附件、消息内缩略图、点击全屏查看，一路打通。
- **语音输入**：默认 Web Speech API，可配置 SiliconFlow 在线 ASR 兜底。
- **长期性能优化**：增量时间线快照（只传变化）、全合成器动画、长会话消息窗口化——面板常开也不再烫机。
- **可携带**：包内自带 Claude Code 引擎，拷到一台**没装任何依赖**的 Windows 机器即可运行（需要 API Key 与网络；执行命令类功能建议有 Git）。
- **个人设定文件**：首次启动在 `data/claude/CLAUDE.md` 生成可编辑的小鲸设定，随数据目录迁移。

## 安装与运行（成品）

发布包在 `release/whale-companion-v<版本>`。桌面与项目根各有一个 `小鲸.lnk`，双击即可；运行后驻留通知区域。

首次使用需在**设置窗口 → 模型**里添加一个模型配置（填入厂商与 API Key）。运行时数据（会话、附件、设定、Claude 配置）保存在 `data/` 目录。

## 本机开发

需要 Windows 和 Node.js 24。任一方式：

```powershell
npm.cmd install
npm.cmd run dev
```

要点：

- 左键单击角色打开/收起气泡，拖动移动位置，右键出选项菜单，中键切换余额卡片（DeepSeek）。
- 输入框 `+` 新建会话，`/` 选择命令与技能，`@` 搜索工作区文件；可拖入或粘贴文件/图片。
- Enter 排队发送，Ctrl+Enter 在当前任务中插入指令；运行中可一键停止，执行超一分钟的命令有单独的中断按钮。
- 会话库支持新建、搜索、置顶、重命名、归档、恢复、删除；上下文用量与手动压缩在模型菜单里。

## 数据与设定

- 会话与附件：`data/conversations`、`data/attachments`
- Claude 配置与会话：`data/claude`（含个人设定 `CLAUDE.md`，引擎的运行数据）
- 设置（模型、称呼、头像、开关）：`data/conversations/library.json`
- 启动环境中可用绝对路径 `DESKTOP_PET_WORKSPACE` 指定工作目录；未指定时打包版以仓库根为工作目录，移出仓库后回退到用户主目录。

## 打包与发布（维护约定）

```powershell
npm.cmd version 0.0.N --no-git-tag-version
npm.cmd run pack:release
```

`pack:release` 依次执行类型检查、测试、构建、asar 校验，产出 `release/whale-companion-v<版本>` 并切换双快捷方式；目标目录已存在会停止（不能覆盖正在运行的版本）。

**每版发布后**：更新 [CHANGELOG.md](./CHANGELOG.md)、`git tag v<版本>`、推送并在 GitHub 建 Release。**本地只保留「最新 + 正在运行」两个版本目录**——历史版本随时可由源码重建（`git checkout` 旧提交 + 打包）。`release/`、`data/`、`node_modules/` 均不入版本控制。

## 当前边界

- 包内自带的 Claude Code 引擎版本较新，在 SDK 会话下不再提供任务工具（系统安装的旧版引擎可用）；引擎查找为「包内优先、系统兜底」。
- 语音质量取决于本机中文语音包与网络；暂无自定义音色、唤醒词、离线模型。
- 跨会话长期记忆、会话分支、独立 side chat 未实现。
- Windows-MCP 已接入配置，实际屏幕与鼠标工具调用待验收。
- 默认角色图由用户提供的参考图编辑，对外发布前需确认素材权利或替换为原创素材。
- 桌面角色与气泡共用一个透明窗口，放大、125% 缩放与多显示器拖拽以实机为准。
