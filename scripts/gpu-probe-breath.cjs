// GPU probe: what the avatar's breath animation costs on its own. One
// transparent 554x560 window (the real stage geometry) with a portrait-shaped
// block, alternating static / breathing every 45 s while
// scripts/gpu-probe-engine-sampler.ps1 records per-process engine counters.
//
//   npx electron scripts/gpu-probe-breath.cjs
//   npx electron scripts/gpu-probe-breath.cjs --shaped   （复刻 setShape 的对照）
//
// The phase markers go to stdout with timestamps; align them with the CSVs
// ts column, then compare engtype_3d per phase for this pid.
'use strict'
const { app, BrowserWindow } = require('electron')

const WIDTH = 554
const HEIGHT = 560
const SHAPED = process.argv.includes('--shaped')

const HTML = `<!doctype html><html><head><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  .portrait {
    position: absolute; left: 50%; bottom: 0; width: 185px; height: 300px; margin-left: -92px;
    border-radius: 46% 46% 40% 40%;
    background: linear-gradient(180deg, #6fa7ff, #2c4781);
    transform-origin: 50% 100%;
  }
  body.breathing .portrait { animation: whale-breath 3.6s ease-in-out infinite; }
  @keyframes whale-breath {
    0%, 100% { transform: translateY(0) scaleY(1); }
    50% { transform: translateY(-2px) scaleY(1.008); }
  }
</style></head><body><div class="portrait"></div></body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT,
    x: 40, y: 40,
    frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    resizable: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  win.show()
  const mark = (label) => console.log(`[breath-probe] ${label} ${new Date().toISOString().slice(11, 19)}`)
  const breathe = (on) => win.webContents.executeJavaScript(
    `document.body.classList.${on ? 'add' : 'remove'}('breathing')`)

  if (SHAPED) {
    // setShape 单变量对照：同样静止的窗口，先无形状、再有形状、最后销毁，
    // 每段 60 秒，看 dwm 与探针进程各自的引擎占用怎么变。
    mark('plain start')
    await sleep(60_000)
    win.setShape([{ x: WIDTH - 168, y: HEIGHT - 186, width: 160, height: 180 }])
    mark('shaped start')
    await sleep(60_000)
    win.destroy()
    mark('closed start')
    await sleep(60_000)
    mark('done')
    app.quit()
    return
  }
  mark('static-1 start')
  await sleep(45_000)
  await breathe(true)
  mark('breath-1 start')
  await sleep(45_000)
  await breathe(false)
  mark('static-2 start')
  await sleep(45_000)
  await breathe(true)
  mark('breath-2 start')
  await sleep(45_000)
  mark('done')
  app.quit()
}

app.whenReady().then(main, (error) => { console.error(error); app.quit() })
