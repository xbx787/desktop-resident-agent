<div align="center">
  <img src="src/renderer/assets/whale-tray-icon.png" alt="小鲸" width="140">

  <h1>小鲸 · Whale Companion</h1>

  <p>住在 Windows 桌面上的鲸鱼少女智能体。点开就能聊天，也能读写文件、执行命令，完成真实工作。</p>

  <p>
    <a href="https://github.com/xbx787/whale-companion/releases/latest"><img src="https://img.shields.io/github/v/release/xbx787/whale-companion?display_name=tag&sort=semver" alt="Latest release"></a>
    <img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4" alt="Windows 10/11 x64">
    <img src="https://img.shields.io/badge/status-preview-orange" alt="Preview">
  </p>

  <p><strong>简体中文</strong> | <a href="README.en.md">English</a></p>
</div>

---

小鲸是一个常驻桌面的智能体：角色待在屏幕角落和通知区域，点开就是完整的对话气泡。它基于 Claude Agent SDK，默认使用 DeepSeek API，能自主使用本机文件和命令工具完成真实工作。

本项目正在开发中，欢迎提issue和发PR，感谢！

## 特色

- **住在桌面上的角色**：点击沉弹、甩呆毛、随机呼吸和换姿势，全部是合成器动画；不聊天时不会持续占用 CPU。
- **完整的对话工作台**：消息、思考链、工具活动共用一条时间线；长回复按片段折叠，工具调用可展开看完整参数和结果。
- **它真的能干活**：读写工作目录里的文件、执行命令、搜索代码，支持 `@` 引用文件/目录/历史会话，拖入图片或粘贴附件。
- **临时会话**：在当前气泡里开一条独立对话，收起后继续主线；不进入会话库，也不打断正在跑的任务。
- **消息刻度导航**：气泡左缘一列刻度，滚轮翻动、Dock 式高亮、点击跳转，长对话里找人很快。
- **长期记忆**：成功回合后提取少量稳定事实，在设置里可改可删；失败不影响当前对话。
- **四种人设**：默认小鲸，另有傲娇、温柔、元气、毒舌四种性格预设，同时切换人设文字、对话头像和桌面角色。
- **自带引擎，开箱即用**：包内已经包含 Claude Code 引擎，解压到有写权限的目录就能运行，不需要安装 Node.js 或 Claude Code。

## 快速开始

1. 从 [Releases](https://github.com/xbx787/whale-companion/releases/latest) 下载最新的 `whale-companion-v*-win-x64.zip`。
2. 解压到有写权限的目录，例如 `D:\Apps\WhaleCompanion`。不要放进 `C:\Program Files`。
3. 进入 `win-unpacked`，双击 `Whale Companion Preview.exe`。
4. 首次启动按向导填写 DeepSeek API Key，并选择工作目录。完成后左键点击角色即可对话。

**系统要求**：Windows 10/11 x64；能访问 DeepSeek API 的网络；一个 DeepSeek API Key。引擎已内置，不需要 Node.js 或 Claude Code。执行命令类工具建议安装 Git for Windows。

> 程序没有代码签名，首次运行可能触发 SmartScreen：点“更多信息”→“仍要运行”。

## 它能做什么

- 读写工作目录里的文件、执行命令、搜索代码和目录。
- `@` 引用文件、目录和已完成的会话；拖入或粘贴图片、附件。
- 每轮 token 与费用统计，中键打开 DeepSeek 余额卡片。
- 语音输入、Markdown 与公式渲染、图片全屏查看。
- 多厂商模型配置：DeepSeek / Kimi / 智谱 GLM / 自定义端点，可测试连接。

## 数据与迁移

所有运行数据都在 `win-unpacked\data`，包括会话、附件、记忆、人设、模型配置和工作目录选择。

- **更新**：退出程序，把旧版 `data` 复制到新版 `win-unpacked` 下，再启动新版。
- **换电脑**：退出程序，复制整个 `win-unpacked` 文件夹；要保留记录就连 `data` 一起复制。
- **API Key**：用 Windows 本机密钥保护加密，换电脑后无法解密。启动向导会自动要求重新填写，模型配置和会话都保留。
- **工作目录**：旧路径在新电脑不存在时会自动回退；在“设置 → 对话 → 工作目录”里确认或迁移。

## 开发

需要 Windows 和 Node.js 24：

```powershell
npm.cmd install
npm.cmd run dev
```

打包：`npm.cmd run pack:release`。逐版变化见 [CHANGELOG.md](./CHANGELOG.md)；更多设计文档在 [docs](./docs)。

## 已知边界

- 目前只提供 Windows x64 便携包，没有安装器和自动更新。
- 角色立绘来自公开角色页，仅作个人桌面使用；公开分发前需要确认素材权利或替换为原创素材。
- 语音质量取决于本机中文语音包与网络。
- `windows-mcp` 等 MCP 工具依赖本机 `~/.claude.json` 配置，不随发布包携带。

---

基于 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 构建，默认模型来自 DeepSeek。
