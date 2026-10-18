import { useState } from 'react'
import { publicErrorText } from '../shared/error-copy'
import { petBridge } from './pet-state'

/** Image results stay a compact line until asked for; the button hands the
 *  file to the system viewer instead of embedding it in the panel. */
export function ToolImageOutput({ images, detail }: {
  images: Array<{ name: string; path: string }>
  detail?: string
}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  async function open(): Promise<void> {
    if (opening) return
    setOpening(true)
    setError('')
    try {
      for (const image of images) await petBridge().openPath(image.path)
    } catch (cause) {
      setError(publicErrorText(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setOpening(false)
    }
  }

  return <div className="panel-tool-image-output">
    <div className="panel-tool-image-prompt">
      <span>图片结果</span>
      <button type="button" disabled={opening} onClick={() => { void open(); }}>
        {opening ? '正在打开…' : '显示原图'}
      </button>
    </div>
    {detail && <pre className="panel-tool-output">{detail}</pre>}
    {error && <p className="panel-tool-image-error" role="status">{error}</p>}
  </div>
}
