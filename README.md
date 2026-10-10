# 小鲸桌面智能体 · 预览版

这是一个 Windows 桌面角色和贴在角色上方的交互气泡的预览版。演示及 DeepSeek 直连模式仅能在本项目的 `sandbox/notes` 新建测试笔记；Claude Code 模式可以自主使用本机文件与命令工具。

仓库地址：<https://github.com/xbx787/desktop-resident-agent>。M0 已验收，M1 语音实体计划见 [docs/2026-10-08-m1-voice-plan.md](./docs/2026-10-08-m1-voice-plan.md)。

## 本机运行

需要 Windows 和 Node.js 24。首次在项目根目录运行：

```powershell
npm.cmd install
npm.cmd run dev
```

左键单击角色打开或收起蓝色半透明气泡；拖动角色可改变位置。角色右键菜单跟随鼠标，和 Windows 通知区域里的小鲸图标使用同一份“选项 / 退出”菜单；托盘图标左键打开对话。中键打开余额卡片，卡片固定在角色正左侧。回复和输入位于同一气泡；输入区平时收起，可用气泡中的按钮展开。右上角从左到右是放大、关闭气泡；关闭气泡后角色与托盘图标仍在。若本机已有 Claude Code 和 `DEEPSEEK_API_KEY` 环境变量，默认选择 **Claude Code · DeepSeek**；未满足条件时默认进入演示模式。

会话库总数不限，可新建、搜索、置顶、重命名、归档、恢复和删除。放大气泡的底部默认显示 5 个快捷切换会话，选项中可设为 1–12 个；闲置自动归档默认关闭。每段会话独立保存消息和 Claude Agent SDK 会话 ID。模型弹层显示 SDK 读取的上下文用量与手动压缩按钮；预计达到窗口 70% 时先请求原生压缩，再核验预算，无法确认用量时拒绝盲发。任务运行且输入为空时显示停止键，有内容时显示发送键。Enter 排队，Ctrl+Enter 将指令以 SDK `priority: 'next'` 接入当前任务的下一个执行阶段；停止会清空待发送队列。

输入框中的 `+` 新建会话，模型按钮只显示图标，回形针或 Ctrl+O 添加小型文本文件；可拖入或粘贴文本文件。输入 `/` 可选择本机 Claude Code 命令和技能，输入 `@` 可搜索当前工作区文件；选中的文件会在发送时校验并读取，聊天记录只保存原始引用。工具活动以可展开的卡片进入同一时间线。当前图片附件后端校验与编码模块已准备好，界面尚未开放图片发送。

语音输入默认使用浏览器 Web Speech API；如果 Windows 无法访问 Google 语音识别服务并报“语音识别网络错误”，可在项目根目录新建 `.env` 文件并填入 SiliconFlow API Key，应用会自动切换为在线 ASR：

```env
SILICONFLOW_API_KEY=sk-xxxxxxxx
SILICONFLOW_MODEL=FunAudioLLM/SenseVoiceSmall
```

当前输入栏的麦克风按钮按设计要求暂时隐藏，语音后端仍保留供后续入口使用。文件直接拖入聊天框，一次最多 5 个；Word 等二进制文件会把本机路径交给 Claude Code 读取，小型文本还会附带内容。DeepSeek 直连模式没有本地文件读取工具，遇到二进制文件会提示切换模型。演示模式不会联系模型；输入 `记录：今天想保存的一句话`，应用会展示拟创建文件的完整路径和内容，点批准才会写入并读回核对。

Claude Code 通道通过官方 Agent SDK 使用本机安装的 `claude.exe`，仅给子进程设置 DeepSeek 官方 Anthropic 兼容地址与 `deepseek-flash[1m]`；不改动现有 Claude Code 配置，也不把 Key 发给渲染界面。SDK 在项目内隔离保存会话，通过目录链接读取现有用户技能；本应用只读加载本机 `.claude.json` 中的 `windows-mcp` 配置并传给 SDK。按用户指定，Claude Code 工具使用无需逐次批准；Windows MCP 真实桌面操作还待用户验收。若要使用原有的 DeepSeek 直连接口和测试笔记工具，启动进程须同时设置 `DESKTOP_PET_ENABLE_DEEPSEEK=1` 和 `DEEPSEEK_API_KEY`，再从模型菜单选“DeepSeek Flash”；直连模型为 `deepseek-flash`。

桌面和项目根目录各有一个 `小鲸.lnk`，当前指向 `release/whale-companion-v0.0.11/win-unpacked/Whale Companion Preview.exe`，无需 VBS 或后台 npm 开发服务。发布目录以 `package.json` 的 `version` 命名（第 N 版 = `v0.0.N`），运行中的版本目录不可覆盖，出新目录后切换快捷方式。运行后小鲸驻留 Windows 通知区域；若图标被系统放入折叠菜单，可由用户在 Windows 中将它拖到可见区域。打包版位于本仓库的 `release` 下时，Agent 以仓库根目录为工作目录；会话库与 Claude 配置保存在仓库 `data` 中。移到其他位置后默认使用用户主目录作为工作目录，数据保存在 EXE 所在目录。需要指定工作目录时，可在启动环境中设置绝对路径 `DESKTOP_PET_WORKSPACE`。应用使用单实例锁，重复启动会显示已有实例。

**中键单击角色**可切换 DeepSeek API 余额卡。卡片显示余额、当前峰谷状态及下次切换时间；余额只在打开或手动刷新时查询，失败时保留上次成功的金额。峰时按北京时间工作日 09:00–12:00、14:00–18:00 计算，周末和中国法定节假日为谷时。当前内置 2026 年官方放假日期；其他年份显示“时段待更新”。设计参考 [DeepSeek Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，余额和计费规则以 [DeepSeek 官方接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)与[价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)为准。

## 验证与生成文件夹版

```powershell
npm.cmd run pack:release
```

发布新版本前先用 `npm.cmd version 0.0.N --no-git-tag-version --ignore-scripts` 递增版本号。`pack:release` 会依次运行类型检查、测试和构建，以本机 `node_modules/electron/dist` 打包进新的 `release/whale-companion-v<version>`，核对 asar 内版本和入口，再更新并回读项目根与桌面的两个快捷方式。目标版本目录已存在时会停止，避免覆盖正在运行的版本。需要核对某项功能是否真的进入包体，可执行 `npm.cmd run verify:asar -- <界面或代码标记>`。位于仓库内的预览版会把会话数据放在项目 `data/conversations`；测试笔记仍在对应预览目录的 `sandbox/notes`。

本机实测结果见 [M0 预览验收记录](docs/2026-10-07-m0-acceptance.md)。

## 当前边界

- 语音功能默认使用浏览器 Web Speech API，识别与合成质量取决于本机 Windows 是否安装中文语音包及网络可达性；若不可用会提示并允许退回文字输入。已支持 SiliconFlow 在线 ASR 作为回退方案。语音尚不支持自定义音色、唤醒词或离线模型。
- 尚未实现跨会话长期记忆、会话分支/检查点和独立 side chat；这些属于 [Claudian 对照计划](docs/2026-10-08-claudian-parity-standard.md)。
- [本机 Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 已接入 SDK 配置，但本版尚未完成实际屏幕与鼠标工具调用验收。
- 默认角色图由用户提供的参考图编辑，原图未修改。此预览素材只用于本地原型；对外发布前需确认原图权利或替换为可发行的原创素材。
- 桌面实体与气泡共用一个透明窗口；放大气泡时窗口改变尺寸，角色屏幕位置保持不变。角色外的透明区域通过窗口形状放行鼠标。放大、125% 缩放和多显示器拖拽由用户实机验收。
