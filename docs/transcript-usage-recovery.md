# 历史用量恢复

`node scripts/recover-transcript-usage.cjs` 默认只读，只输出计数。脚本不输出对话正文、消息 ID 或密钥，也不修改 `data`。运行 `node scripts/recover-transcript-usage.cjs --apply` 才会写入；应用必须已退出。脚本会先将所有待改记录备份到项目 `data/conversations/.usage-recovery-*`，再逐个原子替换，失败时保留备份。

只接受 SDK 根消息与本地用户消息在 60 秒内、正文包含关系成立，并且全库中唯一匹配的回合。assistant 消息按 `message.id` 去重，并通过 `parentUuid` 归属根消息。有歧义、时间顺序异常、超出三小时或用量无效的回合不恢复。已有 `metrics` 的回合不覆盖。

恢复的 `finishedAt` 是转录中最后一条 assistant 消息的观测时间，并非 SDK 结算时间；因此显示的时长也是估算。花费按此观测时间对应的 DeepSeek Flash 档位估算，只在整个回合及前后五分钟档位稳定、所有消息模型一致、输出 token 数据可信时写入。输出 token 为 0 却有输出内容、档位变化或模型不符时保留 `spentYuan` 为空。恢复值标记 `usageSource: transcript_estimate`，不计入会话的 `record.spentYuan`，不能当作完整账单。

脚本需要开发依赖 `esbuild`，因此须在源码仓库安装依赖后运行；便携版不能直接使用。`--apply` 前请确认当前程序已退出，并保留备份，等界面核对后再考虑清理。
