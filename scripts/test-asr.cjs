// 端到端测试：内联实现 transcribeAudio 逻辑，验证 SiliconFlow API
const { readFileSync } = require('node:fs')

async function main() {
  // 加载 .env
  const envPath = 'D:\\DesktopPetProject\\.env'
  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2]
  }

  const apiKey = process.env.SILICONFLOW_API_KEY
  console.log('API Key 长度:', apiKey.length, '前 8 位:', apiKey.slice(0, 8))

  const audioPath = 'D:\\DesktopPetProject\\scripts\\test-zh.wav'
  const buffer = readFileSync(audioPath)
  console.log('音频字节数:', buffer.length)

  // Node 18+ 全局 Blob / FormData / fetch
  const blob = new Blob([buffer], { type: 'audio/wav' })
  const form = new FormData()
  form.append('file', blob, 'recording.wav')
  form.append('model', 'FunAudioLLM/SenseVoiceSmall')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    console.log('开始 fetch...')
    const response = await fetch('https://api.siliconflow.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    })
    console.log('响应状态:', response.status)
    const text = await response.text()
    console.log('响应体:', text)
    if (!response.ok) {
      process.exit(2)
    }
  } catch (error) {
    console.error('请求失败:', error.message)
    if (error.stack) console.error(error.stack)
    process.exit(3)
  } finally {
    clearTimeout(timeout)
  }
}

main()
