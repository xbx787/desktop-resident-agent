# 打包、重启与自检闭环（2026-10-19）

## 目标

把「改完 → 打包 → 重启 → 验证 → 继续改」接成一条命令，重启不再依赖人工点快捷方式，验证结果也不再只存在于聊天里。

## 命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/evolve.ps1
```

流程：

1. 调用 `pack-release.ps1`：类型检查、全量测试、素材审计、构建、asar 校验、切换快捷方式。
2. 找到正在运行的旧实例，用 `--quit` 让它保存对话并退出；最多等 20 秒，不强杀。
3. 启动新版本的 `Whale Companion Preview.exe --self-test`。
4. 等待 `data/self-test/latest.json` 出现且版本号匹配，最多 90 秒。
5. 输出自检 JSON；任一检查失败则非零退出。

## 启动参数

| 参数 | 行为 |
| --- | --- |
| `--restart` | 发送给已运行的实例：等待所有对话空闲后 `app.relaunch()` 并退出；有任务在跑时不打断。 |
| `--self-test` | 新实例启动 3 秒后执行自检，把结果写到 `data/self-test/latest.json`，应用继续运行。 |
| `--self-test-exit` | 与 `--self-test` 同用，自检完成后退出，适合 CI。 |
| `--quit` | 保存后退出，不重启。 |

## 自检项

- `windows`：人物窗口已显示，面板窗口已创建。
- `settings-store`：设置存储可以读取。
- `renderer-html`：`out/renderer/avatar.html` 存在且非空。
- `live2d-model`：解析 `arch-chan` 的 `.model3.json`，逐项确认 Moc、物理、显示信息、纹理和全部 motion 文件存在。
- `live2d-core`：Cubism Core 文件存在且大小合理。

自检直接读取运行目录（开发时是 `out/`，打包后在 `app.asar` 内），因此能发现「资源没进包」和「模型引用写错」两类问题。

## 结果文件

```json
{
  "version": "0.0.87",
  "at": "2026-10-19T...",
  "ok": true,
  "checks": [{ "id": "windows", "ok": true }]
}
```

失败项带 `detail`。新实例的 stdout/stderr 分别写到 `data/self-test/app.out.log` 和 `app.err.log`。

## 边界

- 自检不切换设置、不打开额外窗口，也不修改用户数据。
- 自检不替代真机视觉验收：窗口动画、Live2D 实际渲染和交互仍需人工观察。
- 自检失败只报告，不自动修复；下一次对话读取结果后决定改法。
- 旧实例必须在 20 秒内自行退出；否则脚本报错，保留现场，避免强杀丢对话。
