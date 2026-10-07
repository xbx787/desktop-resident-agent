# 桌面常驻智能体 · M0 预览版

这是一个 Windows 桌面角色和贴在角色上方的交互气泡的第一阶段实现。它把“说话/请求 → 提议动作 → 用户批准 → 执行 → 核验”的任务闭环放在同一个应用里。当前真实操作仅能在本项目的 `sandbox/notes` 新建 Markdown 测试笔记。

仓库地址：<https://github.com/xbx787/desktop-resident-agent>。M0 已验收，M1 语音实体计划见 [docs/2026-10-08-m1-voice-plan.md](./docs/2026-10-08-m1-voice-plan.md)。

## 本机运行

需要 Windows 和 Node.js 24。首次在项目根目录运行：

```powershell
npm.cmd install
npm.cmd run dev
```

左键单击小角色展开上方的蓝色半透明气泡，再单击可收起；按住角色拖动。右键单击角色或气泡只显示“退出”。回复显示在同一气泡的上方，输入区位于下方；平时只留圆形按钮，点击才展开输入框，按 Esc 或右上角的叉号可收起。输入工具栏从左到右提供添加文本文件、模型选择和麦克风入口。若本机已有 Claude Code 和 `DEEPSEEK_API_KEY` 环境变量，默认选择 **Claude Code · DeepSeek**：文字回复分段显示，可按“停止任务”中断。未满足这两个条件时默认进入演示模式。麦克风入口暂未接通语音识别。附件限 5 个文本类文件，每个不超过 32 KB，内容会随消息发送。演示模式不会联系模型；输入 `记录：今天想保存的一句话`，应用会展示拟创建文件的完整路径和内容，点批准才会写入并读回核对。

Claude Code 通道通过官方 Agent SDK 使用本机安装的 `claude.exe`，仅给子进程设置 DeepSeek 官方 Anthropic 兼容地址与 `deepseek-flash[1m]`；不改动现有 Claude Code 配置，也不把 Key 发给渲染界面。当前开放 `Read`、`Glob`、`Grep`、`Bash`、`Edit`、`Write` 六类工具；每次请求在同一气泡内展示参数，等你点“允许一次”或“拒绝”。这部分还需用户实机验收。若要使用原有的 DeepSeek 直连接口和测试笔记工具，启动进程须同时设置 `DESKTOP_PET_ENABLE_DEEPSEEK=1` 和 `DEEPSEEK_API_KEY`，再从模型菜单选“DeepSeek Flash”；直连模型为 `deepseek-flash`。

## 验证与生成文件夹版

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run pack:dir
```

最后一条命令会在 `release/win-unpacked` 生成可运行的 EXE 与配套文件夹，属于本地预览构建。首次打包需要下载 Electron 构建依赖。应用数据和测试笔记会落在可执行文件所在文件夹下的 `data`、`sandbox/notes`；开发运行时则落在本项目内。

本机实测结果见 [M0 预览验收记录](docs/2026-10-07-m0-acceptance.md)。

## 当前边界

- 不具备麦克风识别、语音合成、长期记忆或 Windows GUI 自动操作。Claude Code 的文件与命令工具已接入审批，桌面窗口与鼠标操作仍属于 [后续阶段计划](docs/2026-10-07-mvp-plan.md)。
- [本机 Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 已注册给 Codex；本应用 M0 还没有把它作为执行工具。
- 默认角色图由用户提供的参考图编辑，原图未修改。此预览素材只用于本地原型；对外发布前需确认原图权利或替换为可发行的原创素材。
- 桌面实体与气泡共用一个固定大小的透明窗口；角色外的透明区域通过窗口形状放行鼠标。点击闪烁、125% 缩放和多显示器拖拽由用户实机验收。
