/**
 * Chinese names for the tools the timeline shows, keyed by lower-cased tool name.
 * These live in `shared` on purpose: the main process writes the same label into a
 * tool entry's own text, and the renderer shows it in the row — one map keeps the
 * live row and the persisted history from disagreeing.
 *
 * Every label is a short Chinese verb phrase (≤4 个汉字) so the row reads the same
 * when prefixed with 正在. Unknown English names are classified by keyword and
 * fall back to 工具 instead of leaking raw identifiers; MCP tools get 外部工具.
 */
const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  multiedit: '批量编辑',
  notebookread: '读取笔记',
  notebookedit: '编辑笔记',
  bash: '执行命令',
  // DSH 内核的 shell 工具在 Windows 上叫 pwsh；标签保持和 bash 一致。
  pwsh: '执行命令',
  powershell: '执行命令',
  bashoutput: '读取输出',
  killshell: '停止命令',
  glob: '查找文件',
  grep: '搜索',
  task: '子代理',
  agent: '子代理',
  subagent: '子代理',
  subagentfork: '子代理',
  listagents: '列出代理',
  interruptagent: '中止代理',
  todowrite: '更新任务',
  taskcreate: '新建任务',
  taskupdate: '更新任务',
  taskget: '查看任务',
  tasklist: '列出任务',
  webfetch: '抓取网页',
  websearch: '联网搜索',
  'mcp__deepseek__search': '网页搜索',
  'mcp__deepseek__fetch': '抓取网页',
  search: '搜索',
  enterplanmode: '进入计划',
  exitplanmode: '提交计划',
  askuserquestion: '向你提问',
  lsp: '分析代码',
  skill: '调用技能',
  slashcommand: '运行命令',
  toolsearch: '查找工具',
  workflow: '工作流',
  sendmessage: '发送消息',
  taskoutput: '查看输出',
  taskstop: '停止任务',
  croncreate: '新建定时',
  crondelete: '删除定时',
  cronlist: '列出定时',
  schedulewakeup: '安排唤醒',
  designsync: '同步设计',
  reportfindings: '提交发现',
  enterworktree: '工作区',
  exitworktree: '关工作区',
  listmcpresourcestools: '资源列表',
  readmcpresourcetool: '读取资源',
  readmcpresourcedirtool: '浏览目录',
  // DSH 原生工具：不带标签就会在时间线里露出英文名。
  readimage: '读取图片',
  joblist: '列出任务',
  joboutput: '读取输出',
  jobkill: '停止任务',
  creategoal: '设定目标',
  getgoal: '查看目标',
  updategoal: '更新目标',
  present: '展示',
  listtools: '列出工具',
  cordisinspectlist: '查看插件',
  cordisinspectquery: '查询插件',
  unknown_tool: '工具结果',
  '未知工具': '工具结果'
}

/** 没登记的工具按关键词归类；顺序是从具体到宽泛。 */
const KEYWORD_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/todo|checklist/, '任务'],
  [/subagent|agent|spawn|teammate/, '子代理'],
  [/skill/, '技能'],
  [/workflow/, '工作流'],
  [/goal/, '目标'],
  [/plan/, '计划'],
  [/search|query|find|grep|glob|lookup/, '搜索'],
  [/browser|url|http|web|fetch|deepseek/, '联网'],
  [/read|cat|open|view|load|get|show/, '读取'],
  [/write|save|create|append|export/, '写入'],
  [/edit|patch|replace|modify|update|apply/, '编辑'],
  [/delete|remove|drop/, '删除'],
  [/list|ls|dir/, '列出'],
  [/bash|pwsh|powershell|shell|exec|command|run|terminal/, '执行'],
  [/kill|stop|cancel|abort|interrupt/, '停止'],
  [/job|background/, '后台'],
  [/image|photo|img|picture/, '图片'],
  [/ask|question|prompt/, '提问'],
  [/send|message|notify/, '发送'],
  [/schedule|cron|timer|wake/, '定时'],
  [/memory|note/, '记忆'],
  [/inspect|dump|debug/, '检查'],
  [/plugin/, '插件']
]

/** 先按原样查，再按去掉下划线/连字符的名字查：`todo_write`、`TodoWrite`
 *  和 `todo-write` 指向同一条标签。 */
function lookup(name: string): string | undefined {
  const lower = name.trim().toLowerCase()
  return TOOL_LABELS[lower] ?? TOOL_LABELS[lower.replace(/[_\-\s]/g, '')]
}

function clip(text: string): string {
  return Array.from(text).slice(0, 4).join('')
}

export function toolLabel(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  const known = lookup(trimmed)
  if (known) return known
  const lower = trimmed.toLowerCase()
  const mcp = /^mcp__[^_].*?__(.+)$/u.exec(lower)
  const subject = mcp ? mcp[1] : lower
  const rule = KEYWORD_LABELS.find(([pattern]) => pattern.test(subject))
  if (rule) return rule[1]
  if (mcp) return '外部工具'
  // 已经是中文的名字：保留，最多四个字。
  if (/[\u3400-\u9fff]/u.test(trimmed)) return clip(trimmed)
  return '工具'
}
