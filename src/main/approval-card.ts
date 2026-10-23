/** 打包、重启、自我更新这类“批准/拒绝”请示卡的 HTML 与落点计算。
 *
 *  原来的实现是一个 64×46 的双图标小窗，既看不到要批准什么，也总贴在
 *  面板窗口最下沿。这里把卡片做成蓝底、按内容取自然宽度、标题和正文完整
 *  显示、按钮固定在底部，并把落点算到当前会话标签的正下方。
 */

export interface ApprovalRect {
  x: number
  y: number
  width: number
  height: number
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character
  ))
}

/** 单行最多按 24 个全角字符估宽，长内容到 360px 后换行；短请示保持小卡。 */
export function approvalCardWidth(title: string, detail = ''): number {
  const longestTitle = Math.max(...title.split(/\r?\n/u).map((line) => line.length), 0)
  const longestDetail = Math.max(...detail.split(/\r?\n/u).map((line) => line.length), 0)
  const estimated = Math.max(longestTitle * 13, longestDetail * 6.4) + 28
  return Math.round(Math.min(360, Math.max(220, estimated)))
}

/** 高度估算只用于窗口首次显示；正文超过上限时在卡片内部滚动，不截断文本。 */
export function approvalCardHeight(title: string, detail = '', width = approvalCardWidth(title, detail)): number {
  const charsPerLine = Math.max(10, Math.floor((width - 26) / 6.4))
  const detailLines = detail
    ? detail.split(/\r?\n/u).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
    : 0
  const titleLines = Math.max(1, Math.ceil(title.length / Math.max(8, Math.floor((width - 26) / 13))))
  const estimated = 8 + 13 + titleLines * 19 + (detailLines ? 6 + detailLines * 17 : 0) + 11 + 30 + 12
  return Math.round(Math.min(420, Math.max(96, estimated)))
}

/** 以会话标签的底边中点为锚，卡片居中挂在它下面；下方放不下时翻到标签上方，
 *  并始终留 8px 在工作区内。 */
export function placeApprovalCard(anchor: ApprovalRect, size: { width: number; height: number }, workArea: ApprovalRect): { x: number; y: number } {
  const margin = 8
  const centeredX = anchor.x + anchor.width / 2 - size.width / 2
  const below = anchor.y + anchor.height + 6
  const above = anchor.y - size.height - 6
  const y = below + size.height <= workArea.y + workArea.height - margin ? below : above
  const x = Math.min(workArea.x + workArea.width - size.width - margin,
    Math.max(workArea.x + margin, centeredX))
  return {
    x: Math.round(x),
    y: Math.round(Math.min(workArea.y + workArea.height - size.height - margin,
      Math.max(workArea.y + margin, y)))
  }
}

/** 指针在卡片内的横向位置；卡片被工作区夹住时仍能指回标签中心。 */
export function approvalPointerLeft(anchor: ApprovalRect, card: { x: number; width: number }): number {
  const center = anchor.x + anchor.width / 2 - card.x
  return Math.round(Math.min(card.width - 22, Math.max(22, center)))
}

export function approvalCardHtml(title: string, detail?: string, width = approvalCardWidth(title, detail ?? '')): string {
  const safeTitle = escapeHtml(title.trim() || '需要你的批准')
  const safeDetail = escapeHtml((detail ?? '').trim())
  const body = safeDetail
    ? `<p class="detail">${safeDetail}</p>`
    : ''
  // body 自带 8px 顶部留给三角；卡片本身从 8px 处开始，窗口高度也按这个算。
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
    body{display:flex;justify-content:center;align-items:flex-start;padding:8px 8px 0;color:#eff5ff;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif}
    .card{position:relative;box-sizing:border-box;width:${width}px;max-width:calc(100vw - 16px);padding:11px 13px 12px;border:1px solid rgba(142,181,255,.58);border-radius:12px;background:linear-gradient(160deg,#335ba8,#1d3a75 55%,#142a55);box-shadow:0 10px 26px rgba(2,10,28,.42),inset 0 1px 0 rgba(210,228,255,.18)}
    .pointer{position:absolute;top:-7px;left:var(--pointer-left,50%);transform:translateX(-50%);width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:7px solid #335ba8;filter:drop-shadow(0 -1px 0 rgba(142,181,255,.45))}
    body.is-above{padding:0 8px 8px;align-items:flex-end}
    .card.is-above .pointer{top:auto;bottom:-7px;border-bottom:0;border-top:7px solid #142a55;filter:drop-shadow(0 1px 0 rgba(142,181,255,.45))}
    .title{margin:0;font-size:13px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
    .detail{margin:6px 0 0;max-height:340px;overflow-y:auto;color:#cfe0ff;font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:thin;user-select:text}
    .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:11px}
    .actions a{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:64px;height:28px;padding:0 14px;border-radius:8px;text-decoration:none;font-size:12px;line-height:1;user-select:none}
    .reject{color:#dbe8ff;background:rgba(120,158,226,.16);border:1px solid rgba(160,192,248,.4)}
    .reject:hover{background:rgba(120,158,226,.26)}
    .approve{color:#f7fbff;background:#4b82f0;border:1px solid rgba(170,202,255,.7)}
    .approve:hover{background:#5b91ff}
  </style></head><body><div class="card"><span class="pointer"></span><p class="title">${safeTitle}</p>${body}<div class="actions"><a class="reject" href="https://approval.local/reject" title="拒绝">拒绝</a><a class="approve" href="https://approval.local/approve" title="批准">批准</a></div></div></body></html>`
}
