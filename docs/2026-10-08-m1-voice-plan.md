# M1：可打断的语音实体 — 实施计划

日期：2026-10-08。状态：已立项，待实现。前置阶段：[M0 预览验收记录](./2026-10-07-m0-acceptance.md)。

## 1. 目标

让桌面角色具备中文语音问答能力：用户按住/点击麦克风说话，界面实时显示识别字幕（partial + final），模型回复后自动用语音朗读；说话过程中可随时打断旧回复，角色口型/状态随语音播放变化；识别失败时可一键退回文字输入。

## 2. 验收清单

1. **中文语音识别**：在 Windows 本机完成至少一次中文问答，输入文本正确显示在气泡时间线中。
2. **实时字幕**：说话期间能看到 partial 字幕，停顿时出现 final 字幕，最终用户消息进入时间线。
3. **语音合成**：模型回复以中文语音播放，音色可由系统语音选择。
4. **打断**：播放中再次点击麦克风或开始新输入，旧 TTS 立即停止。
5. **状态联动**：TTS 播放期间角色状态为 `speaking`，停止后恢复；麦克风 listening 期间状态为 `thinking` 或新增 `listening`。
6. **失败回退**：语音识别初始化失败、无麦克风权限或无可用语音时，界面给出可操作的提示并允许切换回键盘输入。
7. **不扩大权限**：M1 仍然只使用 M0 已开放的文件写入能力；语音能力不引入新的网络模型 Key 或外部命令。
8. **测试覆盖**：新增单元测试覆盖语音管理器的状态切换、打断逻辑和字幕合并；至少一次本机实机语音问答由用户人工验收。

## 3. 技术方案

### 3.1 总体选择

采用浏览器内置 **Web Speech API** 作为 M1 默认实现路径：

- `SpeechRecognition`（含前缀 `webkitSpeechRecognition`）用于中文 ASR，支持 `interimResults`。
- `speechSynthesis` + `SpeechSynthesisUtterance` 用于中文 TTS。
- 所有语音处理放在渲染进程，通过 `petBridge` 与主进程已有任务状态联动。

选择理由：
- 零额外依赖，不增加包体积。
- 与现有 React 渲染层天然集成。
- 最快达到 M1 验收标准。
- 后续 M2+ 可替换为在线/本地语音引擎，接口层保持抽象。

已知限制与回退：
- Windows 上 `SpeechRecognition` 依赖系统/网络语音服务，可能不可用；此时提示用户并允许文字输入。
- `speechSynthesis` 中文语音质量取决于系统安装语音；如无可用的中文 voice，提示并仅显示文字。

### 3.2 新增模块

| 文件 | 职责 |
|---|---|
| `src/renderer/voice-engine.ts` | 封装 `SpeechRecognition` 与 `speechSynthesis`，提供 `startListen/stopListen/speak/stopSpeaking` 及事件回调。 |
| `src/renderer/voice-manager.ts` | 协调语音引擎、UI 状态、模型请求、TTS 队列和打断逻辑。 |
| `src/renderer/voice-hint.tsx` | 麦克风按钮、语音状态提示、权限错误提示。 |
| `test/voice-engine.test.ts` | 使用 jsdom + mock 测试语音引擎事件与状态。 |
| `test/voice-manager.test.ts` | 测试打断、字幕合并、TTS 队列。 |

### 3.3 契约变更

`src/shared/contracts.ts`：
- `AvatarState` 新增 `'listening'` 可选状态（或在 M1 复用 `'thinking'` 以减少 UI 改动）。
- 建议新增 `voiceState?: { phase: 'idle' | 'listening' | 'speaking'; finalText?: string; partialText?: string }` 用于面板显示，但 M1 可先通过时间线消息展示 partial 字幕，减少状态机复杂度。

`src/preload/index.ts`：
- 不需要新增 IPC；语音完全在渲染进程处理。若后续需要主进程权限提示，再增加 `pet:request-mic-permission`。

### 3.4 UI 变更

`src/renderer/panel.tsx`：
- 麦克风按钮从 disabled 改为可用，长按/点击开始识别。
- 识别期间在时间线插入一条 `kind: 'user'` 的 interim 消息，final 后替换为正式消息。
- 模型回复到达后自动调用 TTS；TTS 期间显示“正在朗读”并可随时打断。

`src/renderer/avatar.tsx` / `WhalePortrait.tsx`：
- 根据 `snapshot.avatarState === 'speaking'` 切换口型/状态视觉（如嘴部开合、气泡旁小音波）。
- 若新增 `listening` 状态，同步更新视觉。

### 3.5 主进程变更

M1 尽量不改动主进程；仅在需要时：
- `src/main/index.ts`：确保渲染进程的 `navigator.mediaDevices` 在 Electron 中可用（可能需要 `webPreferences` 调整）。
- 如需在窗口失焦时保持语音，检查 `backgroundThrottling` 设置。

## 4. 实现步骤

### Step 1：语音引擎抽象（建议由第一个 Agent 完成）

- 创建 `src/renderer/voice-engine.ts`。
- 检测 `SpeechRecognition` / `webkitSpeechRecognition` 可用性。
- 设置 `lang: 'zh-CN'`，启用 `interimResults` 和 `continuous: false`（单句识别，避免过长时间的识别会话）。
- 提供事件：`onStart`, `onPartial(text)`, `onFinal(text)`, `onError(error)`, `onEnd`。
- TTS 部分：选择中文 voice（`speechSynthesis.getVoices()` 中 `lang.startsWith('zh')`），按句/按段落切分，播放队列；提供 `onSpeakStart`, `onSpeakEnd`, `onSpeakBoundary`（可选）。

### Step 2：语音管理器（建议由第二个 Agent 完成）

- 创建 `src/renderer/voice-manager.ts`。
- 持有 `VoiceEngine` 实例。
- 状态机：
  - `idle` → 点击麦克风 → `listening` → 有 final → `processing`（调用模型）→ 有回复 → `speaking` → 结束 → `idle`。
  - 任何阶段用户再次触发麦克风 → 停止当前 TTS，丢弃当前识别，回到 `listening`。
- 将识别结果通过 `petBridge().sendMessage(text)` 发送给主进程，与现有文字输入共享同一任务流程。
- 模型回复文本到达后，调用 TTS；TTS 期间通过 `petBridge()` 暂无直接改变 avatar 状态的 API，需通过时间线 `system` 消息或利用现有 `taskStatus`/`avatarState` 联动（见 Step 3 讨论）。

### Step 3：状态联动与 UI（建议由第三个 Agent 完成）

- 讨论并决定：`speaking` 状态由谁来维护？
  - 选项 A：渲染进程自行通过 `voice-manager` 在 TTS 开始/结束时调用某 IPC 设置 `avatarState`。需要在 `contracts.ts` 和 `preload/index.ts` 增加 `setAvatarState(state)`。
  - 选项 B：主进程 `AgentRuntime` 在任务状态变化时自动设置 `avatarState: 'speaking'`，但主进程不知道 TTS 何时开始/结束。
  - **推荐**：选项 A，M1 在渲染层增加 `pet:set-avatar-state` IPC，让语音管理器直接驱动角色状态；同时保持主进程对任务状态（planning/executing 等）的权威。
- 更新 `src/shared/contracts.ts`：
  - `AvatarState` 增加 `'listening'`（可选）。
  - `PetAPI` 增加 `setAvatarState(state: AvatarState): Promise<void>`。
- 更新 `src/preload/index.ts` 暴露该 IPC。
- 更新 `src/main/index.ts` 处理 `pet:set-avatar-state`，仅允许渲染进程在限定状态集合内设置，且不能与主进程当前任务状态冲突（例如主进程处于 `executing` 时不允许改为 `idle`）。
- 更新 `src/renderer/panel.tsx` 麦克风按钮、状态提示、打断按钮。
- 更新 `src/renderer/avatar.tsx` / `WhalePortrait.tsx` 显示 speaking/listening 视觉。

### Step 4：测试与验收（建议由第四个 Agent 或同一 Agent 收尾）

- 为 `voice-engine.ts` 编写 mock 测试。
- 为 `voice-manager.ts` 编写打断与状态测试。
- 更新 `README.md` 说明语音功能、权限、已知限制。
- 运行 `npm.cmd run check` 和 `npm.cmd test`。
- 实机测试中文问答、打断、失败回退。
- 更新 `docs/2026-10-08-m1-acceptance.md` 记录验收结果。

## 5. 文件变更清单

- 新增：
  - `src/renderer/voice-engine.ts`
  - `src/renderer/voice-manager.ts`
  - `src/renderer/voice-hint.tsx`
  - `test/voice-engine.test.ts`
  - `test/voice-manager.test.ts`
  - `docs/2026-10-08-m1-acceptance.md`（验收后填写）
- 修改：
  - `src/shared/contracts.ts`
  - `src/preload/index.ts`
  - `src/main/index.ts`
  - `src/renderer/panel.tsx`
  - `src/renderer/avatar.tsx`
  - `src/renderer/WhalePortrait.tsx`
  - `src/renderer/panel.css`
  - `src/renderer/avatar.css`
  - `README.md`
  - `docs/2026-10-07-mvp-plan.md`（标记 M0 完成、M1 进行中）

## 6. 风险与回退

| 风险 | 处理 |
|---|---|
| Windows 无可用中文识别服务 | 检测 `SpeechRecognition` 不存在或 `onerror` 报 `not-allowed`/`service-not-allowed`，提示用户并禁用语音，保留文字输入。 |
| Electron 中麦克风权限弹窗不友好 | 首次点击麦克风时由 `getUserMedia` 触发系统权限请求；如用户拒绝，记录状态并提示。 |
| TTS 播放时窗口失焦被节流 | 检查 `webPreferences.backgroundThrottling` 并视情况关闭；M1 先保持默认，验收时观察。 |
| 语音与文字输入并发冲突 | `voice-manager` 在 listening/speaking 期间屏蔽发送按钮，或统一进入同一任务流。 |
| 分句播放导致状态闪烁 | TTS 队列整体结束前保持 `speaking`，句子边界仅用于口型，不切换整体状态。 |

## 7. 不纳入 M1

- 长期语音记忆与声纹识别。
- 离线本地 ASR/TTS 模型。
- 自定义音色与情感语音。
- 语音唤醒（ always-listening hotword ）。
- 跨应用语音控制（属于 M2）。

## 8. 多 Agent 协作约定

- 每个 Agent 完成一个 Step 后，更新本文件中的 Step 状态（在 Step 标题后标注 `[已完成 by agent]`），并提交独立 commit。
- 若某 Step 需要修改 `contracts.ts` 或 `preload/index.ts`，请优先与 Step 3 协调，避免 IPC 接口冲突。
- 新增文件需通过 `npm.cmd run check`；新增测试需通过 `npm.cmd test`。
- 实机语音验收结果只写入 `docs/2026-10-08-m1-acceptance.md`，不修改本计划文件。
