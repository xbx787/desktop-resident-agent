// @vitest-environment jsdom
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PlanApprovalPanel } from '../src/renderer/plan-approval'
import type { PlanApprovalRequest } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request: PlanApprovalRequest = {
  id: 'p1',
  plan: '## 步骤\n\n1. 读日志\n2. 改配置\n\n`npm test` 验证'
}

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function mount(onDecide: (approved: boolean) => Promise<boolean>): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<PlanApprovalPanel request={request} onDecide={onDecide} />))
  return container
}

describe('PlanApprovalPanel', () => {
  it('renders the plan as markdown with both verdicts', () => {
    const html = renderToStaticMarkup(<PlanApprovalPanel request={request} onDecide={async () => true} />)
    expect(html).toContain('计划')
    expect(html).toContain('<h2>步骤</h2>')
    expect(html).toContain('读日志')
    expect(html).toContain('继续调整')
    expect(html).toContain('开始执行')
    expect(html).not.toContain('发送中…')
  })

  it('routes 继续调整 to a rejection', async () => {
    const verdicts: boolean[] = []
    const view = await mount(async (approved) => { verdicts.push(approved); return true })
    await act(async () => click(view.querySelector('.panel-plan-revise')!))
    expect(verdicts).toEqual([false])
  })

  it('submits an approval and re-enables both buttons when the host fails to deliver it', async () => {
    const verdicts: boolean[] = []
    let resolveDecide: ((value: boolean) => void) | undefined
    const view = await mount((approved) => {
      verdicts.push(approved)
      return new Promise<boolean>((resolve) => { resolveDecide = resolve })
    })
    await act(async () => click(view.querySelector('.panel-plan-approve')!))
    expect(verdicts).toEqual([true])
    expect((view.querySelector('.panel-plan-approve') as HTMLButtonElement).disabled).toBe(true)
    expect((view.querySelector('.panel-plan-revise') as HTMLButtonElement).disabled).toBe(true)
    expect(view.querySelector('.panel-plan-approve')!.textContent).toBe('发送中…')
    await act(async () => { resolveDecide!(false) })
    expect((view.querySelector('.panel-plan-approve') as HTMLButtonElement).disabled).toBe(false)
    expect((view.querySelector('.panel-plan-revise') as HTMLButtonElement).disabled).toBe(false)
  })
})
