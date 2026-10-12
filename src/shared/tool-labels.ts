/**
 * Chinese names for the tools the timeline shows, keyed by lower-cased tool name.
 * These live in `shared` on purpose: the main process writes the same label into a
 * tool entry's own text, and the renderer shows it in the row — one map keeps the
 * live row and the persisted history from disagreeing.
 *
 * Every label is a verb phrase ("读取", "执行命令") so it also reads correctly when
 * the waiting indicator prefixes it with 正在. Anything missing here keeps its own
 * name: MCP tools (`mcp__server__tool`) and any tool a future CLI version adds are
 * proper nouns we have no better word for.
 */
const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  multiedit: '批量编辑',
  notebookread: '读取笔记本',
  notebookedit: '编辑笔记本',
  bash: '执行命令',
  bashoutput: '读取命令输出',
  killshell: '终止命令',
  glob: '查找文件',
  grep: '搜索',
  task: '执行子任务',
  agent: '执行子任务',
  todowrite: '更新任务',
  taskcreate: '新建任务',
  taskupdate: '更新任务',
  taskget: '查看任务',
  tasklist: '列出任务',
  webfetch: '抓取网页',
  websearch: '联网搜索',
  search: '搜索',
  enterplanmode: '进入计划模式',
  exitplanmode: '提交计划',
  askuserquestion: '向你提问',
  lsp: '分析代码',
  skill: '调用技能',
  slashcommand: '运行命令',
  toolsearch: '查找工具',
  workflow: '编排工作流',
  sendmessage: '给伙伴发消息',
  taskoutput: '查看任务输出',
  taskstop: '终止任务',
  croncreate: '新建定时任务',
  crondelete: '删除定时任务',
  cronlist: '列出定时任务',
  schedulewakeup: '安排唤醒',
  designsync: '同步设计稿',
  reportfindings: '提交审查发现',
  enterworktree: '创建隔离工作区',
  exitworktree: '关闭隔离工作区',
  listmcpresourcestools: '列出 MCP 资源',
  readmcpresourcetool: '读取 MCP 资源',
  readmcpresourcedirtool: '浏览 MCP 目录'
}

/** A malformed model stream can leave a blob of prose where the tool name
 *  belongs (a broken call once arrived as a screenful of markup). Anything
 *  that is not name-shaped gets one honest label instead of the raw junk. */
export function toolLabel(name: string): string {
  const trimmed = name.trim()
  const known = TOOL_LABELS[trimmed.toLowerCase()]
  if (known) return known
  if (!trimmed) return trimmed
  return /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) ? trimmed : '未知工具'
}
