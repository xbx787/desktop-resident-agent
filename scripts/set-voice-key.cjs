// One-off: encrypt a SiliconFlow key from a local text file into data/voice.json.
// The key is never printed. Delete this script after use if preferred.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// safeStorage's Windows context follows the app's userData path. The packaged
// app sets it to <dataRoot>/electron, so this one-off must do the same.
const dataRootArg = process.argv[3]
if (dataRootArg) app.setPath('userData', path.join(dataRootArg, 'electron'))

app.whenReady().then(() => {
  try {
    const source = process.argv[2]
    const dataRoot = process.argv[3]
    if (!source || !dataRoot) throw new Error('usage: set-voice-key.cjs <source.txt> <dataRoot>')
    const text = fs.readFileSync(source, 'utf8')
    const line = text.split(/\r?\n/u).find((value) => /siliconflow/iu.test(value) && /sk-/u.test(value))
    if (!line) throw new Error('No SiliconFlow key line found.')
    const match = line.match(/sk-[A-Za-z0-9_-]+/u)
    if (!match) throw new Error('No key in the SiliconFlow line.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secret protection is unavailable.')

    const target = path.join(dataRoot, 'voice.json')
    let current = {}
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')) } catch { /* first save */ }
    const next = {
      version: 1,
      apiKey: `safe-storage:v1:${safeStorage.encryptString(match[0]).toString('base64')}`,
      voice: typeof current.voice === 'string' ? current.voice : 'claire',
      speed: typeof current.speed === 'number' ? current.speed : 1,
      autoSpeak: current.autoSpeak !== false,
      baseUrl: typeof current.baseUrl === 'string' ? current.baseUrl : 'https://api.siliconflow.cn'
    }
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(target, JSON.stringify(next, null, 2), 'utf8')
    console.log(`voice key stored (${match[0].length} chars)`)
    app.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
})
