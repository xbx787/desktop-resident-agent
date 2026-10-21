# DSH ACP 补丁清单（2026-10-21）

`scripts/patch-dsh-runtime.cjs` 给 vendor 里的 `@deepseek-ai/dsh-acp` 补了四个方法。补丁修改的是
`reference/dsh-runtime` 的本地副本，**重装依赖后要重跑**；`npm run pack:release` 会自动执行。
`node scripts/patch-dsh-runtime.cjs --list` 打印当前清单。

## 清单

| 补丁 | 作用 | 检测标记 | 缺失时的行为 |
| --- | --- | --- | --- |
| `session/steer` | 把消息插到当前回合的下一步边界，不打断 | `async steer(params, imageEnabled)` | 宿主退回“打断 + 立即投递” |
| `session/compact` | 手动压缩，走 `compaction.compactNow` | `async compact(params, signal)` | 按钮报中文错误 |
| `session/answer` | 把 `{id, selected, custom}` 答案批次交给 `userQuestions.answer` | `this.ctx.get("userQuestions")` | 提问面板回答失败，问题保留在 DSH 侧 |
| `session/plan` | 把计划模式开关交给 DSH 的 `planMode` 服务，下一步生效 | `async setPlan(params)` | 计划模式退回宿主只读沙箱，DSH 侧不进入计划 |
| `user-questions-answerer` | 把服务级提问（如 `exit_plan_mode`）转给宿主面板，答案直接回传 | `async askHost(request)` | 退出计划模式时提问失败，留在计划模式 |
| `subagent-bridge` | 把子会话的 `tool/call`、`tool/result` 转发给父会话，带 `parentCallId` | `subagentCalls` | 托盘只显示任务与结果摘要，不显示内部步骤 |

## 维护约定

- 每条补丁都幂等：检测到标记就跳过，不会重复插入。
- 锚点不存在时脚本直接退出并报出补丁名，打包会中止，避免打出一个半补丁的包。
- 所有补丁都只做“加方法 / 加监听”，不改动原有逻辑；DSH 升级后先跑脚本，再跑全量测试。
- 构建产物里的 ACP 桥哈希写进 `release/<版本>/BUILD-INFO.json`，用来核对补丁是否真的进了包。

## 已知限制

- `session/answer` 依赖 DSH 的 `userQuestions` 服务；如果内核对提问工具做了改名，需要同步改补丁锚点。
- 子代理的父调用是按“最近一个未结束的 subagent 工具调用”配对的，并发多个子代理时可能配错。
- 没有可用的 API Key，子代理桥只做了 mock 测试，未做真实联调。
