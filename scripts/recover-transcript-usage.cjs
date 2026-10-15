// Recover only uniquely attributable historical Claude SDK usage. Dry-run by default.
// The observed final assistant timestamp and its pricing tier are estimates, not a bill.
// Usage totals may omit transcript messages and are never added to record.spentYuan.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawnSync } = require('node:child_process')

const LIMIT = { files: 64, bytes: 512 * 1024 ** 2, line: 4 * 1024 ** 2, lines: 100_000, records: 1000, recordBytes: 64 * 1024 ** 2 }
const UUID_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(json|jsonl)$/i
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0
const within = (parent, child) => { const r = path.relative(parent, child); return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r) }
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function checkedPaths(projectRoot) {
  const root = fs.realpathSync(projectRoot)
  const data = fs.realpathSync(path.join(root, 'data'))
  const records = fs.realpathSync(path.join(data, 'conversations', 'records'))
  const transcripts = fs.realpathSync(path.join(data, 'claude', 'projects', 'D--DesktopPetProject'))
  if (!within(root, data) || !within(data, records) || !within(data, transcripts)) throw Error('unsafe data directory')
  return { root, data, records, transcripts }
}

function checkedFiles(dir, extension, maximum) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(extension))
  if (names.length > maximum) throw Error('too many source files')
  return names.map((name) => {
    if (!UUID_FILE.test(name)) throw Error('unexpected source filename')
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || fs.realpathSync(file) !== file) throw Error('unsafe source file')
    return { file, name, size: stat.size }
  })
}

function pricingAt(root) {
  // Compile the project's trusted, local price table in memory. No duplicated rates.
  const esbuild = require('esbuild')
  const source = fs.readFileSync(path.join(root, 'src', 'shared', 'deepseek-pricing.ts'), 'utf8')
  const code = esbuild.transformSync(source, { loader: 'ts', target: 'es2022', format: 'cjs' }).code
  const evaluated = { exports: {} }
  new Function('module', 'exports', code)(evaluated, evaluated.exports)
  return evaluated.exports
}

function usageOf(message) {
  const u = message?.usage
  if (!u) return null
  const values = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
  if (!values.every(safeInteger)) return 'invalid'
  const [input, output, cacheRead, cacheCreate] = values
  const total = input + output + cacheRead + cacheCreate
  if (!safeInteger(total)) return 'invalid'
  return { total, input, output, cacheRead, cacheCreate }
}

function hasOutputContent(content) {
  return Array.isArray(content) && content.some((block) => block && ['text', 'thinking', 'tool_use'].includes(block.type) &&
    (typeof block.text === 'string' && block.text.length > 0 || typeof block.thinking === 'string' && block.thinking.length > 0 || block.type === 'tool_use'))
}

async function scanTranscript(file, counts, globalMessageIds) {
  const nodes = new Map(), roots = new Map(), messages = new Map(), assistantEvents = []
  let lineCount = 0
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line) continue
      if (++lineCount > LIMIT.lines || Buffer.byteLength(line) > LIMIT.line) throw Error('transcript bounds exceeded')
      let item
      try { item = JSON.parse(line) } catch { throw Error('invalid transcript JSON') }
      if (typeof item.uuid === 'string') nodes.set(item.uuid, item.parentUuid)
      if (item.type === 'user' && item.promptSource === 'sdk' && item.isSidechain !== true &&
        typeof item.message?.content === 'string' && typeof item.uuid === 'string') {
        roots.set(item.uuid, { text: item.message.content, at: Date.parse(item.timestamp), usages: [], last: null, invalid: false, suspicious: false, models: new Set(), times: [] })
      }
      if (item.type !== 'assistant' || item.isSidechain === true) continue
      if (typeof item.uuid === 'string') assistantEvents.push({ uuid: item.uuid, at: Date.parse(item.timestamp) })
      const id = item.message?.id
      if (typeof id !== 'string' || typeof item.uuid !== 'string') continue
      const usage = usageOf(item.message)
      const at = Date.parse(item.timestamp)
      const suspicious = item.message?.usage?.output_tokens === 0 && hasOutputContent(item.message?.content)
      const existing = messages.get(id)
      if (existing) {
        counts.duplicateSnapshots++
        if (JSON.stringify(existing.usage) !== JSON.stringify(usage)) existing.conflict = true
        existing.suspicious ||= suspicious
        if (Number.isFinite(at)) existing.last = Math.max(existing.last ?? at, at)
      } else messages.set(id, { uuid: item.uuid, usage, last: at, suspicious, model: item.message?.model, conflict: false })
    }
  } finally { reader.close(); stream.destroy() }

  function rootOf(uuid) {
    const visited = new Set()
    while (typeof uuid === 'string' && !visited.has(uuid)) {
      if (roots.has(uuid)) return uuid
      visited.add(uuid)
      uuid = nodes.get(uuid)
    }
    return null
  }
  for (const event of assistantEvents) {
    const rootId = rootOf(event.uuid)
    if (!rootId) continue
    const root = roots.get(rootId)
    if (!Number.isFinite(event.at)) root.invalid = true
    else root.last = Math.max(root.last ?? event.at, event.at)
  }
  for (const id of messages.keys()) {
    // Cross-file duplicates can belong to continued sessions; refusing is safer than double billing.
    if (globalMessageIds.has(id)) throw Error('assistant message id repeats across transcripts')
    globalMessageIds.add(id)
  }
  for (const message of messages.values()) {
    const rootId = rootOf(message.uuid)
    if (!rootId) { counts.orphanMessages++; continue }
    const root = roots.get(rootId)
    if (message.conflict || message.usage === 'invalid' || !Number.isFinite(message.last)) { root.invalid = true; continue }
    if (!message.usage) continue
    root.usages.push(message.usage)
    root.suspicious ||= message.suspicious
    root.models.add(message.model)
    root.times.push(message.last)
  }
  return [...roots.values()]
}

function runningPet(root) {
  if (process.platform !== 'win32') return false
  const quotedRoot = root.replace(/'/g, "''").toLowerCase()
  const script = `$p='${quotedRoot}'; $found=Get-CimInstance Win32_Process -Filter \"Name = 'Whale Companion Preview.exe' OR Name = 'electron.exe'\" -ErrorAction Stop | Where-Object { $_.Name -eq 'Whale Companion Preview.exe' -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($p)) }; if ($found) { 'RUNNING' }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 })
  if (result.status !== 0 || result.error) throw Error('process check unavailable')
  return result.stdout.trim() === 'RUNNING'
}

async function planRecovery(projectRoot = path.resolve(__dirname, '..')) {
  const paths = checkedPaths(projectRoot)
  const recordFiles = checkedFiles(paths.records, '.json', LIMIT.records)
  const transcriptFiles = checkedFiles(paths.transcripts, '.jsonl', LIMIT.files)
  if (transcriptFiles.reduce((sum, entry) => sum + entry.size, 0) > LIMIT.bytes ||
      recordFiles.some((entry) => entry.size > LIMIT.recordBytes)) throw Error('source size limit exceeded')
  const counts = { records: recordFiles.length, transcripts: transcriptFiles.length, roots: 0,
    matched: 0, ambiguous: 0, unmatched: 0, noUsage: 0, invalid: 0, alreadyRecorded: 0,
    recoverableUsage: 0, recoverablePrice: 0, unknownPrice: 0, duplicateSnapshots: 0,
    orphanMessages: 0, recordsToWrite: 0 }
  const records = recordFiles.map(({ file, name }) => {
    const bytes = fs.readFileSync(file)
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw Error('invalid record JSON') }
    if (value.id !== name.slice(0, -5) || !Array.isArray(value.timeline) || !Array.isArray(value.history)) throw Error('invalid record shape')
    const users = value.timeline.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === 'user')
    const history = value.history.filter((entry) => entry.role === 'user')
    if (users.length !== history.length) throw Error('user history and timeline differ')
    return { file, bytes, value, users, history, changed: false }
  })
  const candidates = []
  for (const record of records) for (let index = 0; index < record.users.length; index++) {
    const { entry } = record.users[index]
    const content = record.history[index].content
    const at = Date.parse(entry.time)
    if (typeof content === 'string' && content.length >= 3 && Number.isFinite(at)) candidates.push({ record, entry, content, at, claims: [] })
  }
  const roots = []
  const globalMessageIds = new Set()
  for (const { file } of transcriptFiles) roots.push(...await scanTranscript(file, counts, globalMessageIds))
  counts.roots = roots.length
  const selected = []
  for (const root of roots) {
    if (!Number.isFinite(root.at)) { counts.invalid++; continue }
    const hits = candidates.filter((candidate) => Math.abs(candidate.at - root.at) <= 60_000 && root.text.includes(candidate.content))
    if (hits.length !== 1) { counts[hits.length ? 'ambiguous' : 'unmatched']++; continue }
    hits[0].claims.push(root)
    selected.push({ root, candidate: hits[0] })
  }
  const { getPeakStatus, usageSpendYuan } = pricingAt(paths.root)
  for (const { root, candidate } of selected) {
    if (candidate.claims.length !== 1) { counts.ambiguous++; continue }
    counts.matched++
    if (candidate.entry.metrics !== undefined) { counts.alreadyRecorded++; continue }
    if (!root.usages.length) { counts.noUsage++; continue }
    const finish = root.last
    if (root.invalid || !Number.isFinite(finish) || finish < root.at || finish - root.at > 3 * 60 * 60 * 1000 ||
      finish < candidate.at || root.times.some((time) => time < root.at || time > finish)) { counts.invalid++; continue }
    const usage = { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    for (const part of root.usages) for (const key of Object.keys(usage)) usage[key] += part[key]
    if (!Object.values(usage).every(safeInteger) || usage.total === 0) { counts.noUsage++; continue }
    const metrics = { startedAt: candidate.entry.time, finishedAt: new Date(finish).toISOString(),
      usedTokens: usage.total, usage, usageSource: 'transcript_estimate' }
    // Price is unknown when output usage is suspicious, model differs, or tier may change.
    const startTier = getPeakStatus(root.at)
    const tier = startTier.tier
    const tierStable = tier !== 'unknown' && (!startTier.nextChangeAt || startTier.nextChangeAt > finish + 300_000) &&
      [finish - 300_000, ...root.times, finish + 300_000]
      .every((at) => getPeakStatus(at).tier === tier)
    if (!root.suspicious && root.models.size === 1 && root.models.has('deepseek-flash') && tierStable) {
      const price = usageSpendYuan(usage, finish)
      if (price !== null && Number.isFinite(price) && price >= 0) metrics.spentYuan = price
    }
    candidate.entry.metrics = metrics
    candidate.record.changed = true
    counts.recoverableUsage++
    if (metrics.spentYuan === undefined) counts.unknownPrice++
    else counts.recoverablePrice++
  }
  const changes = records.filter((record) => record.changed).map(({ file, bytes, value }) => ({ file, oldHash: digest(bytes), next: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }))
  counts.recordsToWrite = changes.length
  return { paths, counts, changes }
}

function applyRecovery(plan, processProbe = runningPet) {
  const { paths, changes } = plan
  if (processProbe(paths.root)) throw Error('pet is running; close it before applying')
  const fresh = checkedPaths(paths.root)
  if (fresh.records !== paths.records || fresh.data !== paths.data) throw Error('data directory changed')
  const backup = path.join(paths.data, 'conversations', `.usage-recovery-${Date.now()}-${process.pid}`)
  fs.mkdirSync(backup, { recursive: false })
  try {
    // Finish all backups before any replacement. Never overwrite an existing backup.
    for (const change of changes) {
      if (!within(paths.records, change.file) || fs.realpathSync(change.file) !== change.file ||
          digest(fs.readFileSync(change.file)) !== change.oldHash) throw Error('source changed before backup')
      const target = path.join(backup, path.basename(change.file))
      fs.copyFileSync(change.file, target, fs.constants.COPYFILE_EXCL)
      if (digest(fs.readFileSync(target)) !== change.oldHash) throw Error('backup verification failed')
    }
    for (const change of changes) {
      if (processProbe(paths.root)) throw Error('pet started during apply')
      checkedPaths(paths.root)
      if (fs.realpathSync(change.file) !== change.file || digest(fs.readFileSync(change.file)) !== change.oldHash) throw Error('source changed during apply')
      const temporary = `${change.file}.usage-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        const fd = fs.openSync(temporary, 'wx')
        try { fs.writeFileSync(fd, change.next); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temporary, change.file)
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    }
    return { appliedRecords: changes.length, backedUpRecords: changes.length }
  } catch (error) {
    // Preserve backup, including on partial failure; do not try to restore over a live app.
    throw error
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => !['--apply', '--help'].includes(arg))) throw Error('unknown argument')
  if (args.includes('--help')) { console.log('node scripts/recover-transcript-usage.cjs [--apply]'); return }
  const plan = await planRecovery()
  const result = args.includes('--apply') ? applyRecovery(plan) : { appliedRecords: 0, backedUpRecords: 0 }
  console.log(JSON.stringify({ ...plan.counts, ...result }))
}

if (require.main === module) main().catch((error) => { console.error(`usage recovery failed: ${error.message}`); process.exitCode = 1 })
module.exports = { planRecovery, applyRecovery, checkedPaths }
