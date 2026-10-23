/** Removes vendor branding from text shown in the app. Internal logs and
 *  stored history keep the original wording so failures stay diagnosable. */
export function publicErrorText(message: string): string {
  return message
    .replace(/Claude Code/gi, '小鲸引擎')
    .replace(/Claude Agent/gi, '小鲸引擎')
    .replace(/Claude 客户端/g, '小鲸引擎')
    .replace(/DSH ACP 已退出（[^）]*）(?:[：:][^\n]*)?/g, '连接刚刚中断，消息已保留，请再发送一次。')
}
