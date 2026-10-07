// 端到端测试：直接调用主进程 transcribeAudio，验证 SiliconFlow API
import { readFileSync } from 'node:fs'
import { transcribeAudio } from '../src/main/asr-server.ts'

const apiKey = process.env.SILICONFLOW_API_KEY
if (!apiKey) {
  console.error('SILICONFLOW_API_KEY 未设置')
  process.exit(1)
}

const audioPath = 'D:\\DesktopPetProject\\scripts\\test-zh.wav'
const buffer = readFileSync(audioPath)
console.log('音频字节数:', buffer.length)

const bytes = Array.from(buffer)
console.log('转成 number[]，长度:', bytes.length)

try {
  const result = await transcribeAudio({
    bytes,
    mimeType: 'audio/wav',
    apiKey,
    model: 'FunAudioLLM/SenseVoiceSmall',
  })
  console.log('转写成功:', JSON.stringify(result, null, 2))
} catch (error) {
  console.error('转写失败:', error.message)
  if (error.stack) console.error(error.stack)
  process.exit(2)
}
