# Live2D 接续记录（v0.0.105 基线）

用户要求本轮尽快交付可用改动，并给下一轮明确指导。基线为 `c96b902`，版本号保留 `0.0.105`；打包由用户统一完成。DSH、会话数据和启动入口不在本轮修改范围。

## 当前事实

- 纯 Node 动作生成与校验已覆盖 7 条循环（Idle、Thinking、Working、Waiting、Verifying、Listening、Speaking）及 1 条单次 Poke；`npm run live2d:check` 校验生成一致性、受限 Bézier、循环首尾速度连续与完整模型包引用。
- 技术预览现有 11 个语义动作，加载完成前仍保留 PNG，模型目录与人设绑定保持分离。
- 上轮的 hover 接口和坐标辅助函数已落盘，但没有事件接线。本轮补完这条路径：DOM 命中区转发鼠标位置，模型自行换算局部坐标；离开时回正，按下/拖动时停止跟随，减弱动态效果时不跟随。Pixi 不接管点击与拖动。
- Arch Chan 仅为技术预览。它没有 HitAreas/LipSync；点击由既有 DOM 命中区触发 Poke，语音仅使用语义动作而非真实口型，且它不映射成小鲸。
- 正式小鲸尚无可编辑分层母版、Cubism 工程或运行模型。五个人设的正式 Live2D 绑定仍为空。

## 本轮验证

- 动作管线：通过。
- 交互定向测试：3 个文件、9 项通过；覆盖逻辑画布坐标、边界值、能力门控、拖动、减弱动态效果和离开归中。
- `npm run check`、`npm run build`：通过。构建日志 `.cache/live2d-v105-build.log`。
- `npm test`：158 个文件、904 项通过；6 个文件、28 项门控跳过。日志 `.cache/live2d-v105-tests.log`。`git diff --check` 通过。
- 未启动 GUI，未打包，未改版本号，未提交或推送。
- 点击验收接 `docs/2026-10-09-pending-features.md` 的 91、92。

### 模型包校验补充（2026-10-22）

- `tools/live2d-motion/model-package.mjs` 现会校验 `Moc`、纹理、Physics、DisplayInfo、Pose、表情、motion 和可选声音，并要求它们是模型目录内的非空普通文件。
- 校验在读取引用前拒绝 URL、盘符、反斜杠、控制字符、查询/片段、父目录、双层编码穿越和 junction 逃逸。
- catalog 的 motion 数、表情名称、EyeBlink、LipSync 和 HitAreas 与真实 `model3.json` 交叉验证，避免元数据与资产悄悄漂移。
- 本次重跑：`npm run live2d:check` 通过；模型包与 manifest 的 33 项测试通过；`npm run check` 通过。

### 语义动作扩展（2026-10-22）

- `Live2DAction` 已包含等待、核验、聆听、说话和点击反馈；任务 lane 与语音 lane 会选择对应动作，拖动时不播放动作。
- `live2dActionContracts` 约束持久状态必须循环、一次性状态不得循环，Poke 必须给出正整数恢复时长；profile 可以只声明模型实际具备的动作。
- Poke 会在结束后恢复当时任务动作。旧模型缺少 Poke 时会临时回退，再在 850ms 后恢复，避免点击永久终止工作或思考循环。
- 本次定向验证：5 个文件、23 项通过，另有 `npm run live2d:check` 与 `npm run check` 通过。尚未启动 GUI、打包、提交或推送。

## 下一轮按此顺序接续

1. **制作小鲸最小模型。** 先按 `2026-10-20-cute-persona-live2d-spec.md` 准备可编辑分层母版，补全遮挡部分，再绑定并导出 model3、moc3、纹理、physics、Idle 到 `resources/live2d/xiaojing/`。See-through/PSD2Live 只是候选制作工具，当前未验证为可用的本机生产链；PNG 自动拆层不能算绑定完成。
2. **验收后绑定人设。** 在 catalog 登记真实能力，新增小鲸 performance profile，再接 `persona-visual-binding.ts`。有对应 HitAreas/动作/语义表情/LipSync 资源后，才逐项实现摸头、表情和口型。默认人物与技术预览继续分开。
3. **保持完整包自检。** `src/main/self-test.ts` 已复用模型包校验，并会发现资源目录中新加入的任意 `.model3.json`；后续新增角色只需补 catalog、profile 与绑定，不要恢复固定 Arch 路径的局部 `existsSync` 检查。

## 关键入口

- `src/renderer/Live2DPortrait.tsx`：加载、视觉、动作、视线跟随。
- `src/renderer/avatar.tsx`：唯一 DOM 点击、拖拽入口。
- `src/renderer/live2d-model-catalog.ts`：资源与能力。
- `src/renderer/live2d-performance-profiles.ts`：任务状态到 motion 的映射。
- `src/renderer/persona-visual-binding.ts`：正式人设与技术预览边界。
- `tools/live2d-motion/`：生成与独立校验；保留 LICENSE/UPSTREAM。

窗口隐藏后的后台节流尚未专门实现；当前沿用 Pixi/Chromium 现有调度。本轮通过的是代码与构建检查，不能当作真机视觉验收。
