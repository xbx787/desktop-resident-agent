import type { DiffPreview } from './tool-diff'

const markers: Record<string, string> = { add: '+', del: '-', context: ' ', gap: '' }

/**
 * The change a writing tool made, rendered as a diff: additions on green,
 * removals on red, untouched lines as dim context between them. The counts in
 * the header describe the whole change even when the body is cut short, so the
 * tail says how much is not shown rather than silently ending.
 */
export function ToolDiffBody({ preview }: { preview: DiffPreview }) {
  return <pre className="panel-tool-output panel-tool-diff-body" aria-label={`改动，新增 ${preview.added} 行，删除 ${preview.removed} 行`}>
    {preview.lines.map((line, index) => <span key={index} className={`panel-tool-diff-line is-${line.kind}`}>{markers[line.kind]}{line.text}</span>)}
    {preview.hidden > 0 && <span className="panel-tool-diff-line is-more">… 其余 {preview.hidden} 行未显示</span>}
  </pre>
}
