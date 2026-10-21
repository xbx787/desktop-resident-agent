# 给后续 Agent 的硬规则（2026-10-21 快捷方式事故）

这次事故不是快捷方式写错，而是**正在被快捷方式引用的 `release\whale-companion-v0.0.95`
目录被另一个构建流程删掉/清空**。Windows 发现目标不存在，提示用户删除快捷方式；
用户点了删除，桌面入口就没了。

## 必须遵守

1. **禁止删除、移动、重命名、覆盖正在被快捷方式或进程引用的 release 目录。**
   0.95 就是这样消失的：16:24 还有一个构建在写 `release\whale-companion-v0.0.95`，
   之后整个目录不存在，快捷方式目标变成空路径。

2. **禁止用 `npm run pack:dir` 或 electron-builder 直接输出到已有版本目录。**
   electron-builder 会先清空输出目录；必须用新的版本号（0.0.97、0.0.98…），
   走 `npm run pack:release`，不要复用旧目录。

3. **打包后、切换快捷方式前，逐项验证：**
   - `win-unpacked\Whale Companion Preview.exe` 存在，FileVersion 等于目录版本；
   - `app.asar` 内 `out/main/index.js` 存在（`npm run verify:asar`）；
   - `resources\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 存在；
   - 用独立数据目录启动一次，窗口真的出现；
   - 以上全过，才允许 `switch-shortcuts.ps1`。

4. **切换快捷方式后立刻 `Test-Path` 目标。** 目标不存在就不要保存快捷方式，
   更不要删除旧快捷方式。

5. **目标缺失时先恢复构建或重新指向可用版本，不要点“删除快捷方式”。**
   Windows 的“找不到原文件，是否删除”是个陷阱。

6. **多个 Agent 不得同时操作 `release`、`reference`、`src`。**
   打包前先确认没有其他 electron-builder / pack-release / node 构建在跑；
   需要并行时用不同版本目录，并写清交接。

7. **旧版本只增不删。** 需要回退时用 `*-prev-*`，不要清理 release 目录。

## 当前状态

- `release\whale-companion-v0.0.95` **已不存在**，不要以为它还在；
- 0.95 只剩旧包 `release\whale-companion-v0.0.95-prev-20261021-0012`（旧代码）；
- 当前稳定版是 **0.0.96**：
  `release\whale-companion-v0.0.96\win-unpacked\Whale Companion Preview.exe`
- 桌面和项目根的 `小鲸.lnk` 已指向 0.96；
- 下次要打包请用 **0.0.97**，不要再碰 0.96。
