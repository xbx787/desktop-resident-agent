# 本地已有 MCP / 技能 / 插件发现（2026-10-19）

## 问题

库页原来只读取 `data/libraries/index.json`，也就是只有“通过应用市场添加”的条目。机器上已经存在的 Claude 配置和插件目录完全不可见：`~/.claude.json` 里有 3 个 MCP 服务器，`~/.claude/plugins/installed_plugins.json` 里有 7 个已安装插件和 18 个插件自带技能，但库页是空的。

## 数据来源

| 库 | 扫描位置 | 说明 |
| --- | --- | --- |
| MCP | `~/.claude.json` 的 `mcpServers` | Claude Code 的全局服务器；HTTP 取 `url`，stdio 取 `command`/`args`，`env` 只列变量名 |
| MCP | `<workspace>/.mcp.json` 的 `mcpServers` | 项目级服务器 |
| 插件 | `~/.claude/plugins/installed_plugins.json` | 读取每个安装项的 `installPath`、版本、时间；描述优先取 `.claude-plugin/plugin.json` |
| 技能 | `~/.claude/skills/*/SKILL.md` | 用户级技能 |
| 技能 | `<workspace>/.claude/skills/*/SKILL.md` | 项目级技能 |
| 技能 | `<dataRoot>/claude/skills/*/SKILL.md` | 应用内 Claude 配置目录 |
| 技能 | `<plugin installPath>/skills/*/SKILL.md` | 插件自带技能，来源标为“插件 <名字>” |

`SKILL.md` 只读文件头 16 KB，解析 YAML frontmatter 的 `name` 和 `description`；缺失时用目录名和“本地技能”兜底。

## 行为

- **只读**：发现的条目标记 `external: true`，不写入 `index.json`；`remove()` 只删应用索引里的条目，不会删除用户的 Claude 配置或插件文件。UI 对这类条目显示“本地已有 / 已在环境中”，不提供移除按钮。
- **每次 list 重新扫描**：`LibraryStore.list()` 每次都读取固定目录。设置页进入“库”标签时调用一次 `libraries()`，所以新增或删除的 skill 不需要重启应用。
- **去重**：同一个 `kind:id` 只保留一条；应用市场安装的条目排在前，发现条目追加在后。
- **上限**：技能扫描最多 400 条，避免异常目录一次列出过多文件。
- **隔离**：只有显式传入 `homeDir` 才扫描用户目录。生产入口传 `userHome` 和当前 workspace；测试和预览不传，保持干净。

## 未做

- 不自动把发现的插件加入 SDK 的 `plugins` 选项。插件是否生效由 Claude 用户设置和 SDK 的 `settingSources` 决定；库页只负责展示。
- 不读取 `env` 的值，只显示变量名，避免密钥进入渲染进程。
- 不做文件监听（`fs.watch`）。进入设置时刷新已经满足“新加 skill 可见”，常驻监听会为一个低频操作增加进程负担。
