import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { segmentTurn, splitTurnTail } from '../src/renderer/timeline-groups'
import { TurnProcess, WorkCluster, workFacts, workFactsText } from '../src/renderer/work-cluster'

const start = Date.parse('2026-10-09T00:00:00.000Z')
const at = (offsetSeconds: number) => new Date(start + offsetSeconds * 1000).toISOString()

const thought = (id: string, from: number, to: number): TimelineEntry =>
  ({ id, kind: 'thinking', text: '先看一下日志。', time: at(from), endedAt: at(to) })
const tool = (id: string, name: string, from: number, status: 'running' | 'done' = 'done'): TimelineEntry =>
  ({ id, kind: 'tool', text: `${name} · 摘要`, time: at(from), tool: { toolUseId: id, name, status } })
const note: TimelineEntry = { id: 'a1', kind: 'assistant', text: '日志按天分好了。', time: at(30) }

describe('segmentTurn', () => {
  it('groups consecutive thinking and tool entries, keeping model sentences outside', () => {
    const items = [thought('t1', 0, 12), tool('x1', 'Bash', 12), tool('x2', 'Read', 16), note, tool('x3', 'Task', 40)]
    const segments = segmentTurn(items)
    expect(segments.map((segment) => segment.kind)).toEqual(['work', 'note', 'work'])
    expect(segments[0]).toMatchObject({ id: 't1', items: [items[0], items[1], items[2]] })
    expect((segments[2] as { items: TimelineEntry[] }).items).toEqual([items[4]])
  })

  it('collapses nothing when there is no work', () => {
    expect(segmentTurn([note])).toEqual([{ kind: 'note', entry: note }])
  })
})

describe('workFacts', () => {
  it('counts thinking seconds, commands and the stretch duration', () => {
    const items = [thought('t1', 0, 12), tool('x1', 'Bash', 12), tool('x2', 'Bash', 20), tool('x3', 'Read', 26)]
    const facts = workFacts(items, start, false)
    expect(facts.steps).toBe(4)
    expect(facts.toolCount).toBe(3)
    expect(facts.thinkingSeconds).toBe(12)
    expect(facts.elapsedSeconds).toBe(26)
    expect(workFactsText(facts)).toBe('思考 00:12，3 项操作，执行命令 ×2、读取 ×1')
  })

  it('runs the clock from the start while the stretch is still going', () => {
    const facts = workFacts([thought('t1', 0, 3), tool('x1', 'Bash', 3, 'running')], start + 9_000, true)
    expect(workFactsText(facts)).toBe('思考 00:03，1 项操作，执行命令 ×1')
  })

  it('names the tail of a long tool list by category', () => {
    const items = ['Bash', 'Read', 'Grep', 'Task'].map((name, index) => tool(`x${index}`, name, index))
    expect(workFacts(items, start, false).toolSummary).toBe('执行命令 ×1、读取 ×1、搜索 ×1 等 4 类')
  })
})

describe('WorkCluster', () => {
  const render = (node: React.ReactElement) => renderToStaticMarkup(node)
  const entry = (_entry: TimelineEntry) => <span />

  it('shows the folded summary header with the facts, and no restated request', () => {
    const items = [thought('t1', 0, 12), tool('x1', 'Bash', 12)]
    const html = render(<WorkCluster items={items} running={false} renderEntry={entry} />)
    // The row carries the operation count, never a per-second clock.
    expect(html).not.toContain('<span>思考 00:12</span>')
    expect(html).not.toContain('<span>00:12</span>')
    // The header says what state the stretch is in.
    expect(html).toContain('已工作')
    // The tool breakdown moved off the row: it is the hover title now.
    expect(html).toContain('title="思考 00:12，1 项操作，执行命令 ×1"')
    expect(html).toContain('<span>1 项操作</span>')
    expect(html).not.toContain('panel-cluster-purpose')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })

  it('stays open while the stretch is running', () => {
    const items = [tool('x1', 'Bash', 0, 'running')]
    const html = render(<WorkCluster items={items} running renderEntry={entry} />)
    expect(html).toMatch(/<details[^>]*\sopen/)
    expect(html).toContain('is-running')
    // The state word follows the same live/settled pair as a thinking row.
    expect(html).toContain('正在工作')
    expect(html).not.toContain('已工作')
  })
})

describe('splitTurnTail', () => {
  it('keeps the final sentence out and folds everything before it', () => {
    const items = [thought('t1', 0, 12), tool('x1', 'Bash', 12), note, tool('x3', 'Task', 40)]
    const { head, tail } = splitTurnTail(segmentTurn(items), false)
    expect(head.map((segment) => segment.kind)).toEqual(['work'])
    expect(tail.map((segment) => segment.kind)).toEqual(['note', 'work'])
  })

  it('folds nothing while the turn is live, or when no sentence could end it', () => {
    const live = segmentTurn([thought('t1', 0, 12), note])
    expect(splitTurnTail(live, true).tail).toBe(live)

    const noNote = segmentTurn([thought('t1', 0, 12), tool('x1', 'Bash', 12)])
    expect(splitTurnTail(noNote, false).tail).toBe(noNote)

    const onlyNote = segmentTurn([note])
    expect(splitTurnTail(onlyNote, false).tail).toBe(onlyNote)
  })
})

describe('TurnProcess', () => {
  const render = (node: React.ReactElement) => renderToStaticMarkup(node)
  const entry = (_entry: TimelineEntry) => <span />
  const midNote: TimelineEntry = { id: 'a2', kind: 'assistant', text: '先改这里。', time: at(30) }

  it('folds clusters and mid-turn sentences into one closed row that still holds the process', () => {
    const segments = segmentTurn([thought('t1', 0, 12), tool('x1', 'Bash', 12), midNote, thought('t2', 40, 52)])
    const html = render(<TurnProcess segments={segments} renderEntry={entry}
      renderNote={(item) => <p className="note-row">{item.text}</p>} />)
    expect(html).toContain('is-turn-process')
    // Closed by default — the reader sees the outcome, not the process.
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    // The row states the whole stretch: the settled state word plus the
    // operation count; no clock on the bar.
    expect(html).toContain('已工作')
    expect(html).toContain('<span>1 项操作</span>')
    expect(html).not.toContain('<span>00:52</span>')
    expect(html).toContain('title="思考 00:24，1 项操作，执行命令 ×1"')
    // Opening it lays the same pieces back out: the work cluster and the note.
    expect(html).toContain('panel-cluster-summary')
    expect(html).toContain('note-row')
    expect(html).toContain('先改这里。')
  })
})
