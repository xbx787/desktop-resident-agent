# DSH 迁移法务与基线（Phase 0）

日期：2026-10-20

## 结论

当前 `@anthropic-ai/claude-agent-sdk@0.3.292` 的 `package.json` 标注 `SEE LICENSE IN README.md`，实际 `LICENSE.md` 写的是：

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

这不是 OSI 开源许可证。继续把 `claude-agent-sdk` 与打包内的 `claude.exe` 随应用分发，存在无法由本项目单方面消除的许可/合规风险。迁移到 DSH（MIT）是合理决策。

## 依赖清单

| 依赖 | 版本 | 许可 | 处理 |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.292 | Anthropic 商业许可（保留所有权利） | Phase 4 切换后移除；打包内 `claude.exe` 一并移除 |
| `@deepseek-ai/dsh` | 0.2.1-rc.2 | MIT | 作为新内核，锁定精确版本 |
| `@deepseek-ai/dsh-agent-loop` | 0.2.1-rc.2（next） | MIT | 通过 `dsh` profile 间接使用 |
| `@deepseek-ai/dsh-sdk-minimal` | 0.2.1-rc.2（next） | MIT | 通过 `dsh --profile sdk-minimal` 使用 |
| `pixi.js` / `pixi-live2d-display` | 6.5.10 / 0.4.0 | MIT | 与本迁移无关 |
| DeepSeek API | — | 商业 API 条款 | 用户自己的 Key；不在仓库内分发密钥 |
| `bilibili-api-python`（如以后引入） | — | GPL-3.0-or-later | 不引入主应用；如作为用户本机运行时依赖，需单独隔离 |

注意：npm 上未加 scope 的 `dsh@1.0.1` 是 `infusion/node-dsh` 的无关包，不能使用。必须使用 `@deepseek-ai/dsh`。

## 版本锁定

- 新内核唯一入口：`@deepseek-ai/dsh@0.2.1-rc.2`。
- 通过 `dsh --profile sdk-minimal` 启动，stdio 换行分隔 JSON-RPC。
- 升级前必须重新跑 Phase 3/4 的事件映射与回归测试；预览期 breaking changes 不自动跟进。
- 开发期把 DSH 安装在独立目录（`reference/dsh-poc`），不污染主依赖，直到 Phase 3 通过。

## 迁移法务动作

1. Phase 3 保留 `claude_code` 回退，但不再新增 Claude 专属能力。
2. Phase 4 默认切到 DSH 后，移除 `@anthropic-ai/claude-agent-sdk` 依赖与打包脚本里的 `claude.exe` 复制。
3. 更新 `README.md` / `README.en.md` / `NOTICE.md`：DSH MIT、DeepSeek API、以及不再分发 Anthropic SDK。
4. 不把 DSH 插件市场里的第三方自动化插件打进主应用；插件只在用户显式安装时加载，并保留许可证审计。
5. AI 生成内容、B 站自动化等场景继续遵守平台条款与《人工智能生成合成内容标识办法》；这些不属于内核迁移范围，但会写进产品边界文档。

## 未决问题

- DeepSeek API 的商业条款需要在正式分发前复核（API Key 由用户提供，应用不转售模型服务）。
- DSH 的 `sdk-minimal` profile 默认 danger-full-access shell；主应用必须用隔离工作目录和权限边界包装，不能把默认策略直接暴露给用户。
- DSH 预览版本可能改变 JSON-RPC 字段；Phase 2 的 PoC 会记录实际协议。

## Phase 0 验收

- [x] 识别 Claude SDK 的非开源许可
- [x] 锁定 DSH 版本与正确 npm scope
- [x] 列出迁移期间与完成后的移除项
- [x] 记录预览期升级门禁与回退要求
