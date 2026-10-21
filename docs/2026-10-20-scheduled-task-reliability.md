# 定时任务的失效原因与可靠兜底（2026-10-20）

## 现象

11:07 设置的 12:00 一次性任务没有在 12:00 触发，用户没有收到任何回复。任务文件里也没有留下任务。

## 根因

Claude Code 的 CronCreate 不是 Windows 计划任务，只在 Claude Code 交互进程运行、且 REPL 空闲时触发。12:00 时 Claude Code 进程不在运行，任务被标记为错过；15:11 会话重新启动后，持久化任务被补投，但补投内容的规则是「先 AskUserQuestion 询问是否现在运行，用户确认后才执行」，所以它没有直接开始工作。任务随后被消费，`.claude/scheduled_tasks.json` 变为空。

证据：`data/claude/projects/D--DesktopPetProject/71f27bfb-...jsonl` 中的 queue-operation 明确写着 `missed while Claude was not running` 和 `Do NOT execute this prompt yet`。

结论：依赖交互进程的定时器不能保证准点执行；需要系统级触发器。

## 可靠方案

Windows 计划任务 + headless Claude Code，不依赖当前交互窗口：

- `Whale-1800`：2026-10-20 18:00 一次性任务。
- `Whale-1815`：18:15 备份，只在结果文件为空时执行。
- 两个任务都启用 `StartWhenAvailable`，电脑休眠/关机错过时在恢复后尽快运行。
- 动作：`powershell -File scripts/wake-1800.ps1 -Slot 1800`。

`scripts/wake-1800.ps1` 的流程：

1. 每次运行检查并修复 `Whale-1800` / `Whale-1815`（不存在就注册，禁用就启用）。
2. 结果文件已存在且非空则直接退出，保证幂等。
3. 从 `~/.claude/settings.json` 读取 `ANTHROPIC_AUTH_TOKEN`，设置 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_MODEL=deepseek-flash`、`DEEPSEEK_API_KEY`。
4. 用 headless `claude -p` 执行任务文件 `data/scheduled/2026-10-20-1800-task.md`。
5. 结果写 `data/scheduled/2026-10-20-1800-result.md`；stdout 写 `wake-1800.stdout.log`，日志写 `wake-1800.log`。

## 无头模式的权限与搜索

- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 会把 `--permission-mode bypassPermissions` 强制降级为 default，所以必须显式传 `--allowedTools`：
  `mcp__deepseek__search,mcp__deepseek__fetch,Read,Write,Bash`。
- 应用内的 DeepSeek 搜索 MCP 只存在于 Electron 进程；headless 使用独立 stdio server `scripts/deepseek-search-mcp.cjs`，配置在 `scripts/deepseek-mcp.json`。
- 已实测：headless 模型返回 OK；MCP 搜索返回 DeepSeek 结果；Write 写出文件。

## 18:00 任务内容

任务文件 `data/scheduled/2026-10-20-1800-task.md` 要求：

1. 确认「dsh」指什么，判断是否值得更换 agent 内核，给出成本、收益、风险。
2. 搜索并判断 B 站/QQ「肥鱼」刷屏现象，附来源。
3. 分析 12:00 定时任务为什么没触发，区分进程不在、REPL 忙、任务被消费、补投只询问。
4. 检查 `Whale-1800` / `Whale-1815`，不存在就修复，把结果写进报告。

## 双保险

- Windows 计划任务负责准点执行，不依赖交互会话。
- CronCreate 18:00 任务保留作汇报兜底：先等 60 秒，读取结果文件；有结果就汇报，没有才自己执行。

## 边界

- 计划任务以当前用户身份运行，注册/启用不需要管理员；如果系统策略拒绝，需要在错误日志里明确写出。
- 任务只读搜索、写报告，不修改源码、不打包、不重启。
- headless 任务会产生 DeepSeek API 费用；搜索按次计费。
