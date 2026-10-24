/** 宿主追加给 DSH 的系统提示规则。
 *
 *  人设正文由 `persona.ts` 负责，这里只放宿主自己的约定：目标归属、联网开关、
 *  提问方式、命令说明、输出风格和用户追加指令。拆出来以后能单独测试，也不会
 *  和人格文案搅在一起。
 */
export interface DshHostRulesInput {
  /** false 时模型必须直接知道不能联网，不能先试一次。 */
  webSearchEnabled: boolean
  /** 'Explanatory' | 'Learning' | 其他（原样保留为空）。 */
  outputStyle?: string
  appendSystemPrompt?: string
}

export function buildDshHostRules(input: DshHostRulesInput): string {
  return [
    '',
    '宿主说明：目标由桌面应用管理，不要调用 create_goal、get_goal 或 update_goal。',
    ...(input.webSearchEnabled
      ? ['联网搜索优先使用 mcp__pet__deepseek_search 和 mcp__pet__deepseek_fetch；它们由 DeepSeek 服务端完成。']
      : ['当前已禁用联网搜索：不要调用任何搜索或抓取工具，也不要尝试通过其他方式联网；直接基于已有信息回答，信息不足时说明缺什么。']),
    '需要用户确认时直接用文字提问；不要调用宿主没有答案 UI 的提问工具。',
    '长任务里每做完一小步，用一两句中文向用户说明正在做什么、刚发现了什么；写在回复正文里，不要只放进思考，也不要等全部做完才开口。',
    '调用命令类工具（pwsh / bash）时，description 字段必须用简短中文写明这条命令要做什么，例如“检查进程路径”；界面会直接显示它，写英文用户看不懂。',
    '开工前先读 data/memory/NOTES.md（临时记忆：各会话踩过的坑和验证过的结论）。这份文件不进上下文，不读就等于没有；与本任务相关就照它做，无关就跳过。',
    '思考链（thinking / 推理过程）也必须用中文写：界面会把它直接展示给用户，英文思考对用户就是噪音。',
    ...(input.outputStyle === 'Explanatory' ? ['回答时先解释原理与推理依据，再给结论。'] : []),
    ...(input.outputStyle === 'Learning' ? ['用教学式引导回答：先给线索，再逐步给出答案。'] : []),
    ...(input.appendSystemPrompt ? [input.appendSystemPrompt] : [])
  ].join('\n')
}
