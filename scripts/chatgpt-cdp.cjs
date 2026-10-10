// ChatGPT CDP driver: talks to the Edge debug session (cdp-setup.ps1) over
// the DevTools Protocol, so the page is driven with real JS on the DOM — no
// coordinate clicking. Node 24's built-in WebSocket keeps this dependency-free.
//
//   node scripts/chatgpt-cdp.cjs status            — tab url + login/stream probe
//   node scripts/chatgpt-cdp.cjs navigate <url>    — navigate the tab
//   node scripts/chatgpt-cdp.cjs eval "<js>"       — evaluate JS, print the value
//   node scripts/chatgpt-cdp.cjs send "<text>"     — put text in the composer and click 发送
//   node scripts/chatgpt-cdp.cjs wait-image <n>    — wait until generated images ≥ n, print newest image URL
//   node scripts/chatgpt-cdp.cjs click-edit        — click the newest "编辑" (edit) button
//   node scripts/chatgpt-cdp.cjs download <path>   — fetch the newest generated image into <path>

const ENDPOINT = 'http://127.0.0.1:9222/json'

async function findTab() {
  const response = await fetch(ENDPOINT)
  const list = await response.json()
  const pages = list.filter((target) => target.type === 'page')
  const chat = pages.find((target) => target.url.includes('chatgpt.com')) ?? pages[0] ?? null
  if (!chat) throw new Error('no page target in the debug session')
  return chat
}

function cdp(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const message = { id: 1, method, params }
    const timer = setTimeout(() => { try { socket.close() } catch {} reject(new Error('cdp timeout')) }, 60000)
    socket.onopen = () => socket.send(JSON.stringify(message))
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.id !== 1) return
      clearTimeout(timer)
      try { socket.close() } catch {}
      if (payload.error) reject(new Error(payload.error.message))
      else resolve(payload.result)
    }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
  })
}

async function evaluate(wsUrl, expression) {
  const result = await cdp(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'JS exception')
  return result.result?.value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Probe snippets shared by several commands. Generated images render as
 *  blob: URLs on the page itself (not oaiusercontent hosts as they used to),
 *  so the filter takes either — blob first, since that is what the current
 *  build hands the img tag. */
const BIG_IMAGE = `[...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 200 && (i.src.startsWith('blob:') || /oaiusercontent|estuary/.test(i.src)))`
const IMG_COUNT = `(${BIG_IMAGE}).length`
const NEWEST_IMG = `(() => { const imgs = ${BIG_IMAGE}; const last = imgs[imgs.length - 1]; return last ? last.src : null })()`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const tab = await findTab()
  const ws = tab.webSocketDebuggerUrl

  if (command === 'status') {
    const probe = await evaluate(ws, `JSON.stringify({
      url: location.href,
      composer: Boolean(document.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"]')),
      stopButton: Boolean(document.querySelector('[data-testid="stop-button"]')),
      images: (${IMG_COUNT})
    })`)
    console.log(probe)
    return
  }

  if (command === 'navigate') {
    await cdp(ws, 'Page.navigate', { url: rest[0] })
    console.log('navigated')
    return
  }

  if (command === 'eval') {
    console.log(JSON.stringify(await evaluate(ws, rest.join(' '))))
    return
  }

  if (command === 'send') {
    const text = JSON.stringify(rest.join(' '))
    const filled = await evaluate(ws, `(() => {
      const el = document.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"]')
      if (!el) return 'no composer'
      el.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('insertText', false, ${text})
      return el.innerText.slice(0, 40)
    })()`)
    await sleep(400)
    const sent = await evaluate(ws, `(() => {
      const button = document.querySelector('[data-testid="send-button"]') || [...document.querySelectorAll('button')].find((b) => /send|发送/.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')))
      if (!button) return 'no send button'
      button.click()
      return 'clicked'
    })()`)
    console.log(JSON.stringify({ filled, sent }))
    return
  }

  if (command === 'wait-image') {
    const target = Number(rest[0] ?? 1)
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      const images = await evaluate(ws, IMG_COUNT)
      const busy = await evaluate(ws, `Boolean(document.querySelector('[data-testid="stop-button"]'))`)
      if (images >= target && !busy) {
        await sleep(1500)
        console.log(JSON.stringify({ images, src: await evaluate(ws, NEWEST_IMG) }))
        return
      }
      await sleep(3000)
    }
    throw new Error('image wait timed out')
  }

  if (command === 'click-edit') {
    const clicked = await evaluate(ws, `(() => {
      const buttons = [...document.querySelectorAll('button')]
      const edit = buttons.filter((b) => (b.getAttribute('aria-label') || '').startsWith('编辑生成的图像')).pop()
      if (!edit) return 'no edit button'
      edit.click()
      return 'clicked edit'
    })()`)
    console.log(clicked)
    return
  }

  if (command === 'download') {
    const out = rest[0]
    if (!out) throw new Error('usage: download <path>')
    const dataUrl = await evaluate(ws, `(async () => {
      const imgs = ${BIG_IMAGE}
      const last = imgs[imgs.length - 1]
      if (!last) return null
      const blob = await (await fetch(last.src)).blob()
      return await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob) })
    })()`)
    if (!dataUrl) throw new Error('no image found')
    const { writeFileSync } = require('node:fs')
    writeFileSync(out, Buffer.from(String(dataUrl).split(',')[1], 'base64'))
    console.log('saved ' + out)
    return
  }

  console.log('usage: status | navigate <url> | eval <js> | send <text> | wait-image <n> | click-edit | download <path>')
}

main().catch((error) => { console.error('CDP_ERROR: ' + error.message); process.exit(1) })
