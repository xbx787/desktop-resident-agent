import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { planRecovery, applyRecovery, checkedPaths } = require('../scripts/recover-transcript-usage.cjs')
const project = path.resolve(__dirname, '..')
const cache = path.join(project, '.cache')
const fixtures: string[] = []
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
]
const iso = '2026-10-14T00:00:00.000Z'

function fixture() {
  fs.mkdirSync(cache, { recursive: true })
  const root = fs.mkdtempSync(path.join(cache, 'usage-recovery-test-'))
  fixtures.push(root)
  const records = path.join(root, 'data', 'conversations', 'records')
  const transcripts = path.join(root, 'data', 'claude', 'projects', 'D--DesktopPetProject')
  const pricing = path.join(root, 'src', 'shared')
  for (const dir of [records, transcripts, pricing]) fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(project, 'src', 'shared', 'deepseek-pricing.ts'), path.join(pricing, 'deepseek-pricing.ts'))
  return { root, records, transcripts }
}

function record(records: string, id: string, content: string, metrics?: object) {
  const value = {
    id, timeline: [{ id: `local-${id}`, kind: 'user', time: iso, text: content, ...(metrics ? { metrics } : {}) }],
    history: [{ role: 'user', content }]
  }
  const file = path.join(records, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

function transcript(transcripts: string, id: string, content: string, output: number, extra?: { duplicate?: boolean; tailNoUsage?: boolean }) {
  const root = `root-${id}`
  const assistant = `assistant-${id}`
  const user = { uuid: root, parentUuid: null, type: 'user', promptSource: 'sdk', isSidechain: false, timestamp: iso,
    message: { role: 'user', content: `System context. ${content} End context.` } }
  const response = { uuid: assistant, parentUuid: root, type: 'assistant', isSidechain: false,
    timestamp: '2026-10-14T00:00:05.000Z', message: { id: `msg-${id}`, model: 'deepseek-flash',
      content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: output,
        cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } }
  const rows = [user, response, ...(extra?.duplicate ? [{ ...response, uuid: `${assistant}-copy`, parentUuid: assistant }] : []),
    ...(extra?.tailNoUsage ? [{ uuid: `${assistant}-tail`, parentUuid: assistant, type: 'assistant',
      isSidechain: false, timestamp: '2026-10-14T00:00:20.000Z', message: { id: `msg-tail-${id}` } }] : [])]
  fs.writeFileSync(path.join(transcripts, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'))
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (!root.startsWith(`${cache}${path.sep}`)) throw Error('unsafe test cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('bounded transcript usage recovery', () => {
  it('deduplicates assistant message ids and never writes during dry-run', async () => {
    const { root, records, transcripts } = fixture()
    const file = record(records, ids[0], 'unique request')
    transcript(transcripts, ids[0], 'unique request', 5, { duplicate: true, tailNoUsage: true })
    const before = fs.readFileSync(file)
    const plan = await planRecovery(root)
    expect(plan.counts).toMatchObject({ roots: 1, matched: 1, duplicateSnapshots: 1,
      recoverableUsage: 1, recoverablePrice: 1, recordsToWrite: 1 })
    expect(fs.readFileSync(file)).toEqual(before)
    const next = JSON.parse(plan.changes[0].next.toString())
    expect(next.timeline[0].metrics).toMatchObject({ usageSource: 'transcript_estimate',
      finishedAt: '2026-10-14T00:00:20.000Z', usedTokens: 18,
      usage: { total: 18, input: 10, output: 5, cacheRead: 1, cacheCreate: 2 } })
  })

  it('leaves ambiguous matches and suspicious output unpriced', async () => {
    const { root, records, transcripts } = fixture()
    record(records, ids[0], 'same request')
    record(records, ids[1], 'same request')
    record(records, ids[2], 'another request')
    transcript(transcripts, ids[0], 'same request', 5)
    transcript(transcripts, ids[2], 'another request', 0)
    const plan = await planRecovery(root)
    expect(plan.counts).toMatchObject({ roots: 2, ambiguous: 1, matched: 1,
      recoverableUsage: 1, recoverablePrice: 0, unknownPrice: 1 })
    const next = JSON.parse(plan.changes[0].next.toString())
    expect(next.timeline[0].metrics.spentYuan).toBeUndefined()
  })

  it('refuses a running pet, backs up before a fixture apply, and is idempotent', async () => {
    const { root, records, transcripts } = fixture()
    const file = record(records, ids[0], 'apply request')
    transcript(transcripts, ids[0], 'apply request', 5)
    const old = fs.readFileSync(file)
    const plan = await planRecovery(root)
    expect(() => applyRecovery(plan, () => true)).toThrow(/running/)
    expect(fs.readFileSync(file)).toEqual(old)
    expect(applyRecovery(plan, () => false)).toMatchObject({ appliedRecords: 1, backedUpRecords: 1 })
    const backupDir = fs.readdirSync(path.join(root, 'data', 'conversations')).find((name) => name.startsWith('.usage-recovery-'))
    expect(backupDir).toBeTruthy()
    expect(fs.readFileSync(path.join(root, 'data', 'conversations', backupDir!, path.basename(file)))).toEqual(old)
    expect((await planRecovery(root)).counts).toMatchObject({ alreadyRecorded: 1, recordsToWrite: 0 })
  })

  it('rejects a redirected target directory before apply', async () => {
    const { root, records, transcripts } = fixture()
    record(records, ids[0], 'safe request')
    transcript(transcripts, ids[0], 'safe request', 5)
    const plan = await planRecovery(root)
    plan.paths.records = cache
    expect(() => applyRecovery(plan, () => false)).toThrow(/changed/)
    expect(checkedPaths(root).records).toBe(records)
  })

  it('rejects repeated assistant message ids across transcript files', async () => {
    const { root, records, transcripts } = fixture()
    record(records, ids[0], 'first request')
    record(records, ids[1], 'second request')
    transcript(transcripts, ids[0], 'first request', 5)
    transcript(transcripts, ids[1], 'second request', 5)
    const file = path.join(transcripts, `${ids[1]}.jsonl`)
    const rows = fs.readFileSync(file, 'utf8').split('\n').map((line) => JSON.parse(line))
    rows[1].message.id = `msg-${ids[0]}`
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'))
    await expect(planRecovery(root)).rejects.toThrow(/repeats/)
  })
})
