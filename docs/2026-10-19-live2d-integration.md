# Live2D Cubism 技术预览接入（2026-10-19）

## 目标与边界

把 Live2D 作为角色动作引擎的预研底座，先验证真实 Cubism 渲染、物理和参数驱动。当前 PNG 立绘仍是默认形象，也是模型或 Core 加载失败时的自动后备。Arch Chan 只作技术预览，不进入人设选择器，不冒充小鲸。

## 构建边界

- `electron.vite.config.ts` 的 renderer `publicDir` 指向项目根下的 `resources/`。必须用绝对路径；相对路径会被 Vite 按 renderer root 解析，导致资源没有复制。
- 构建后资源落在 `out/renderer/live2d/**`，与 `avatar.html` 同目录。模型 JSON 里的相对纹理、物理、表情路径因此保持可用。
- `package.json` 的 `files` 已包含 `out/**/*`，资源会进入 `app.asar`。发布包内路径为 `file://…/app.asar/out/renderer/live2d/…`；这一点仍需真机打包后验证 Chromium 是否能直接读取 asar 内的模型与纹理。
- 运行时不依赖 CDN。Cubism Core 由本地 `<script>` 加载，`pixi-live2d-display/cubism4` 在 Core 就绪后动态导入。

## 资源白名单

`src/renderer/live2d-manifest.ts` 是唯一模型清单：

- 只允许 `live2d/` 下的相对路径，拒绝协议 URL、反斜杠和 `..`。
- `resolveLocalLive2DResource(resource, baseUrl, kind)` 返回 `string | null`；`kind` 固定模型必须是 `.model3.json`、Core 必须是 `live2dcubismcore.min.js`。
- 解析后再次检查协议（`file` / `http` / `https`）、路径含 `/live2d/`、不存在 `../`。
- `Live2DPortrait` 使用这一个资源解析器；失败不抛到窗口，材料缺失时回退 PNG。

## 渲染接入

- `avatar.tsx` 读取 `conversationLibrary.settings.avatarRenderer`：
  - `sprite`（默认）→ 现有 `WhalePortrait`。
  - `live2d-preview` → `Live2DPortrait`，模型固定 `arch-chan`。
  - 选择预览时，原有 `WhalePortrait` 保持显示至模型 `onReady`；模型或 Core 加载失败时保留该立绘，不出现空人物窗口。切换渲染方式会重置失败状态，失败的本地 Core / 动态运行时 Promise 也会清除，下一次切回可以重试。
- Live2D 模式不启动待机行为调度器，不播放点击回弹、呆毛摆动和 `AvatarStateEffects`；避免 CSS 循环与模型内部动作双重驱动。
- 命中区仍由 `.avatar-hit-target` 负责；Live2D canvas `pointer-events: none`，不注册 Pixi 互动。模型没有裁剪 PNG 尺寸时，按当前人物大小建立固定正方形命中区并继续走现有主进程形状同步。
- 模型卸载时先从 Pixi stage 脱离，再单次释放模型；系统启用“减少动态效果”时，停止 motion 并关闭模型自动更新。
- Arch-chan 预览带六个项目内制作的状态 motion（Idle / Acknowledge / Thinking / Working / Success / Failure）。动作只在状态本身变化时请求，流式回复引起的时间线刷新不会把同一动作从头重播；Success / Failure 按 manifest 的 force 优先级播放。
- `pixi-live2d-display@0.4.0` 会解析 motion3 的 `Meta.Loop`，但不会自动把它写入 `CubismMotion.setIsLoop()`。运行时会先加载持久动作、显式打开循环，再发起播放；状态切换先停旧动作，异步加载结果用递增 token 防止旧状态迟到覆盖新状态。
- Idle / Thinking / Working 的每条参数曲线首尾一致，并内置闭眼—睁眼曲线；这样持续 motion 占用更新周期时仍会眨眼，退出时不会把角度、眉眼或嘴形残留到下一状态。
- 当前源码只保留 `Live2DPortrait` 这一条加载路径；未接入 UI 的重复运行时已移除，避免两套缓存、资源解析和销毁语义长期漂移。

## 许可结论

| 资产 | 许可 | 处理 |
| --- | --- | --- |
| Arch-chan 模型 | CC0 1.0 | 可再分发；保留 `LICENSE.md`，在 README 标注来源与预览定位 |
| Live2D Cubism Core | Live2D Proprietary Software License | 作为 Redistributable Code 随应用分发；不修改版权头；`NOTICE.md` 记录来源、日期和 SHA-256；公开发布前复核当前条款 |
| pixi.js / pixi-live2d-display | MIT | 随依赖许可分发 |

README 中英双语已加入对应条目。

## 验证

- Live2D 资源边界、模型清单、生命周期、动作优先级和动作资产测试 9 项通过。资产测试逐条核对 model3 引用、参数 ID、线性段、元数据计数、循环标志和首尾接缝。
- 类型检查、生产构建通过；构建输出包含完整的 `out/renderer/live2d`，Cubism Core 的 SHA-256 与 `NOTICE.md` 记录一致。
- 当前源码全量测试为 141 个文件、822 项通过；另有 2 个显式门控的 Live SDK 文件（14 项）跳过。
- 当前源码版本为 v0.0.88；按用户要求本轮没有重新打包。
- `scripts/check-asar.cjs` 现在同时比较当前 `out/**` 与 asar 内同路径文件的 SHA-256；同版本号下源码已更新、安装包未重打时会明确失败，避免把旧包误认成当前构建。
- 未做真机渲染验收：需要重新打包并重启，在设置 → 外观切换到 Live2D 预览观察实际模型、物理和 asar 资源加载。

## 后续

1. 打包后验证 asar 内 `file://` 模型加载和六种状态的实际动作幅度；若 Chromium 拒绝资源读取，改为 `extraResources` 或自定义协议。
2. 按[小鲸原创 Cubism 制作与接入规范](./2026-10-19-xiaojing-cubism-production.md)制作原创小鲸模型和同名状态 motion；当前 Arch-chan 动作只作运行时回归夹具，不能直接当小鲸成品。
3. 为语音通道增加独立口型输入，为点击增加模型内 poke 动作，再做 persona 到模型的一一绑定；没有对应模型的人设继续使用本人的 PNG。
