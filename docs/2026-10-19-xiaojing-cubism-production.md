# 小鲸原创 Live2D v1 制作与接入规范（2026-10-19）

## 目标

把小鲸从当前的静态 PNG 角色升级为可长期维护的原创 Cubism 角色。当前 `Arch Chan` 仅保留为渲染回归样本：它不是小鲸皮肤；项目为它制作的六组动作只用于验证状态仲裁、循环和资源打包，也不能冒充小鲸的角色动作。现有小鲸 PNG 是扁平成图，不能通过强拆产生高质量的真动作。

正式路径固定为：**原创分层原画 → Cubism Editor 绑定与动作 → Cubism 4 兼容运行产物 → 现有 `pixi-live2d-display` 渲染器**。

## 资产边界

### 私有制作源文件

下列源文件放在私有素材仓库，不随安装包分发：

- 小鲸母版 PSD 或 Clip Studio 源文件；
- Cubism `.cmo3` 模型工程；
- Cubism `.can3` 动作工程；
- 原画授权、版本和修改记录。

### 随程序分发的运行产物

完成验收后，运行文件放入 `resources/live2d/xiaojing/`，并只经 `live2d-manifest.ts` 白名单引用：

- `.model3.json`、`.moc3`、纹理 PNG；
- `.physics3.json`、`.cdi3.json`、必要的 `.pose3.json`；
- 表情 `.exp3.json`；
- 状态动作 `.motion3.json`。

不把 PSD、`.cmo3` 或 `.can3` 放进安装包。小鲸正式模型必须是原创，或取得明确的修改、绑定、再导出和应用分发授权。

## 原画分层要求

原画师交付的是可以覆盖形变的完整部件，不是从成图切下来的碎片。透明背景，角色、服装和配件保持统一的原创 Q 版视觉。

最低层级：

1. 头、脸底色、脸部阴影、颈部和身体。
2. 左右眼白、虹膜、瞳孔、高光、上下眼皮、睫毛、左右眉、腮红。
3. 嘴形、口腔和舌头。
4. 前发、左右侧发、后发、呆毛分别独立；被头发遮住的脸部必须补全。
5. 发箍、蝴蝶结、袖子、裙摆、手部等需要摆动或轻微形变的部件；遮挡处补全绘制。

导入 Cubism 前，属于同一视觉部件的线稿和色块需适当合并，避免把一个部件拆成无法维护的大量网格。可参照 [Cubism 的 PSD 导入说明](https://docs.live2d.com/en/cubism-editor-manual/psd-import/)。

## v1 参数、表情与动作

### 基础参数

- `ParamAngleX`、`ParamAngleY`、`ParamAngleZ`；
- `ParamBodyAngleX`、`ParamBodyAngleY`、`ParamBodyAngleZ`；
- `ParamEyeLOpen`、`ParamEyeROpen`、`ParamEyeBallX`、`ParamEyeBallY`；
- 左右眉、`ParamMouthOpenY`、`ParamMouthForm`、`ParamCheek`、`ParamBreath`；
- 前发、侧发、后发、呆毛、蝴蝶结等物理参数。

### 表情

首版至少包含 `Smile`、`Focus`、`Concerned`、`Surprise`、`Sleepy`。后续语音口型直接驱动 `ParamMouthOpenY`，不以额外的假口型 CSS 替代。

### 与现有状态通道一致的动作组

| 动作组 | 小鲸状态 | 播放规则 |
| --- | --- | --- |
| `Idle` | 待机 | 低优先级循环：呼吸、眨眼、轻微注视 |
| `Acknowledge` | 收到任务、倾听 | 普通优先级，一次性回应 |
| `Thinking` | 规划、等待、压缩 | 普通优先级，可循环 |
| `Working` | 执行工具、验证 | 普通优先级，可循环 |
| `Success` | 完成 | 高优先级，只播放一次 |
| `Failure` | 失败、取消 | 高优先级，只播放一次 |

当前 `live2dActionForLanes` 已有对应状态语义。正式资产只需在模型清单中填写实际 motion group 和索引，不重写对话、工具或语音状态系统。

## 制作里程碑

1. **M0，角色母版**：固定原创小鲸设定，取得源文件和授权。
2. **M1，基础绑定**：在 Cubism Viewer 验收头部转向、眨眼、眼球、嘴形、呼吸、头发和呆毛物理。
3. **M2，状态动作**：完成六个动作组和五个表情，导出 Cubism 4 兼容包。
4. **M3，桌面接入**：登记白名单，在 Electron 中验收透明窗口、125%/150% DPI、拖拽命中区、失败回退和减少动态效果。
5. **M4，互动扩展**：接入口型、鼠标注视、点击互动、睡眠和主动提醒动作。

`pixi-live2d-display@0.4.0` 当前支持 Cubism 2/3/4；若制作端使用更新版 Cubism，必须先导出并验收 Cubism 4 兼容运行产物，或单独完成运行时升级验证。动作导出文件和嵌入方式可参照 [Cubism 的 MOC3 / Motion3 导出说明](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/)。

## 上线验收

- Cubism Viewer 中每个参数、表情和动作都无破面、穿帮或裸露的遮挡区。
- 小鲸模型在桌面透明窗口中不抢鼠标事件；拖动、左键、右键和中键仍由既有命中区处理。
- 模型加载失败时即时保留 PNG 立绘；切换预览可重试，不留下空窗口。
- 系统关闭动画效果时，停止 motion 与 Cubism 自动更新。
- 打包后核对 `.model3.json` 引用的全部文件都在 asar 内，并保留 Core 许可与哈希记录。
