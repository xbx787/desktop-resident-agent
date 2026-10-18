// One-off: verify the stored SiliconFlow key against both sites without printing it.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const dataRootArg = process.argv[2]
if (dataRootArg) app.setPath('userData', path.join(dataRootArg, 'electron'))

app.whenReady().then(async () => {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'voice.json'), 'utf8'))
    const prefix = 'safe-storage:v1:'
    if (!String(record.apiKey || '').startsWith(prefix)) throw new Error('voice.json has no encrypted key')
    const key = safeStorage.decryptString(Buffer.from(record.apiKey.slice(prefix.length), 'base64'))
    for (const base of ['https://api.siliconflow.com', 'https://api.siliconflow.cn']) {
      try {
        const response = await fetch(`${base}/v1/audio/speech`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'FunAudioLLM/CosyVoice2-0.5B',
            input: '你好，我是小鲸。',
            voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
            response_format: 'mp3',
            speed: 1
          })
        })
        const bytes = (await response.arrayBuffer()).byteLength
        console.log(`${base} status=${response.status} type=${response.headers.get('content-type')} bytes=${bytes}`)
      } catch (error) {
        console.log(`${base} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    app.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
})
