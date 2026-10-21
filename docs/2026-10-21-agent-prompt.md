# 给新 Agent 的初始 Prompt（小鲸项目·发布纪律）

你接手的是 `D:\DesktopPetProject` 的小鲸桌面程序维护工作。项目里可能同时存在多个 Agent、多个构建流程和用户的真实会话数据。你的第一原则不是“尽快改完”，而是**不破坏用户正在使用的版本、数据与入口**。任何删除、覆盖、重建发布目录的动作，都必须先停下来核对。

## 一、先读，再动手

开始任何工作前，按顺序读：

1. `D:\DesktopPetRescue\workspace\HANDOFF.md`
2. `D:\DesktopPetProject\docs\2026-10-21-agent-safety.md`
3. `D:\DesktopPetRescue\workspace\RESCUE-REPORT.md`

读完后先用中文复述：当前稳定版本、正在运行的实例、你要做的事、你准备写入哪些路径。不要直接开干。

## 二、绝对禁止

1. **禁止删除、移动、重命名、覆盖任何正在被快捷方式、运行进程或 BUILD-INFO 引用的 `release\whale-companion-v*` 目录。**
2. **禁止用 `npm run pack:dir`、electron-builder 或任何构建命令直接输出到已存在的版本目录。** electron-builder 会先清空输出目录；必须新建版本号。
3. **禁止删除用户的 `data`、会话记录、附件、备份、快捷方式。** 包括 `D:\DesktopPetProject\data` 和 `D:\DesktopPetRescue\data`。
4. **禁止在目标路径不存在时保存或“修复”快捷方式。** 更不要因为 Windows 提示“找不到原文件”就删除 `.lnk`。
5. **禁止用 `if (false)`、改打包后运行时、吞掉异常等方式绕过图片/模型能力检查。**
6. **禁止在另一个构建正在运行时并行改 `release`、`reference`、`src`、`package.json`。**
7. **禁止把 `deepseek-flash[1m]` 原样写进 DSH 配置。** `[1m]` 只是 Claude Code 侧别名，写入 DSH 前必须规范化为 `deepseek-flash`。
8. **禁止覆盖当前稳定版。** 当前稳定版是 **0.0.96**；0.0.95 已被删除，不要重建 0.0.95。下一次打包用 **0.0.97**。

## 三、发布前必须做的检查

打包前：

- 确认没有其他 `electron-builder` / `pack-release` / 构建中的 node 进程；
- 在 `D:\DesktopPetProject\.agent-build.lock` 写锁（内容：Agent 名称、PID、时间、目标版本）；锁存在且未过期时，停止并报告，不要抢；
- 确认 `package.json` 版本号只增不减，目标目录不存在。

打包必须使用：

```powershell
npm run pack:release
```

它会执行类型检查、全量测试、DSH 补丁校验、资源审计、链接修复、asar 校验和快捷方式切换。不要绕过它手搓打包。

打包后、切换快捷方式前，逐项验证并保留输出证据：

1. `win-unpacked\Whale Companion Preview.exe` 存在，`VersionInfo.FileVersion` 等于目录版本；
2. `npm run verify:asar` 通过，`app.asar` 内 `out/main/index.js` 存在；
3. `resources\dsh\node_modules` 下的 DSH 入口文件存在：该层作用域目录名以 at 符号开头（即 deepseek-ai），里面是 `dsh\lib\bin.js`；
4. `scripts\fix-dsh-links.ps1 -Check` 报告 0 个问题；
5. 用**独立数据目录**启动一次，窗口“小鲸”真的出现；
6. 以上全部通过，才允许切换快捷方式；切换后立即 `Test-Path` 目标。

任何一项失败：停止，不切换快捷方式，不删除旧版本，报告失败项。

## 四、快捷方式与版本目录

- 只通过 `scripts\switch-shortcuts.ps1` 切换快捷方式；
- 切换前必须确认目标 exe 存在且版本匹配；
- 目标不存在时：先恢复构建或重新指向一个已验证的可用版本；不要删除快捷方式；
- 发布目录只增不删；回退用 `*-prev-*`；
- 如果发现某个版本目录突然消失：先查 `BUILD-INFO.json` 的 `builtAt`、快捷方式时间、`release` 目录时间，判断是谁在删/覆盖；不要盲目重建到同一路径。

## 五、模型与图片能力的硬约束

- DSH 实际模型必须是 `deepseek-flash`（目录里声明了 `inputModalities: ["text","image"]`）；
- `deepseek-flash[1m]` / `deepseek-v4-flash` 进入 DSH 前必须规范化；
- `setProvider()`、`applySessionOptions()`、`syncDshAcpModelPatch()` 都不能绕过规范化，不能吞错；
- 保留 `projectImagesForTextModel` 的文本占位和 `read_image` 的能力判断；
- DSH 入口文件是 `dsh\lib\bin.js`，位于发布包的 `resources\dsh\node_modules` 下；
  那一层作用域目录名以 at 符号开头（即 deepseek-ai）。让 Agent 用文件读取工具
  按**绝对路径**读它。不要在聊天里用 at 符号写包名；at 引用只解析工作区相对路径。
- 声称“修好读图”前，必须用真实 DeepSeek 请求验证：
  - 握手 `image:true`；
  - `read_image` 能识别已知颜色；
  - 含图历史后连续 3 条纯文本不报 `UNSUPPORTED_CONTENT`；
  - 纯文本模型带图历史不会整轮失败。

## 六、数据与实例

- 0.93 救援实例（`D:\DesktopPetRescue\data`，Claude/cloud 内核）**不要停、不要删**；
- 0.96 是当前主版本；用户数据在 `D:\DesktopPetProject\data`；
- 测试一律用独立 `DESKTOP_PET_DATA` 和 `DESKTOP_PET_WORKSPACE`，不要拿用户会话做实验；
- 不要删除 `C:\Users\<用户>\Desktop\小鲸.lnk` 或项目根的 `小鲸.lnk`。

## 七、汇报与停止条件

- 全程中文；每完成一步报告“改了什么、证据在哪、下一步是什么”；
- 不确定就写“待验证”，不要编造成功；
- 遇到以下情况立即停止并报告，不要自行发挥：
  - 目标版本目录被其他流程占用/删除/覆盖；
  - 快捷方式目标不存在；
  - 另一个构建正在运行；
  - 用户要求覆盖当前稳定版；
  - 需要删除任何用户数据或版本目录。

记住：**发布目录不是你临时的构建缓存，是用户正在用的程序。** 先验证，再切换；先建新版本，再谈清理。不要再玩火。
