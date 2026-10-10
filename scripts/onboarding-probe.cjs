// Onboarding probe: loads the built wizard page and screenshots the welcome
// step and the guide step, so the first-run window can be eyeballed without
// launching the whole app.
//
//   npx electron scripts/onboarding-probe.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PAGE = path.join(__dirname, '..', 'out', 'renderer', 'onboarding.html')
const SHOT_WELCOME = path.join(os.tmpdir(), 'onboarding-welcome.png')
const SHOT_REGISTER = path.join(os.tmpdir(), 'onboarding-register.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 560, height: 620, show: true, frame: true, backgroundColor: '#0c1b3e' })
  await win.loadFile(PAGE)
  await new Promise((resolve) => setTimeout(resolve, 700))
  writeFileSync(SHOT_WELCOME, (await win.webContents.capturePage()).toPNG())
  // "开始配置" moves to the guide step.
  await win.webContents.executeJavaScript(`document.querySelector('.onboarding-primary')?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 350))
  writeFileSync(SHOT_REGISTER, (await win.webContents.capturePage()).toPNG())
  console.log(`shot: ${SHOT_WELCOME}`)
  console.log(`shot: ${SHOT_REGISTER}`)
  app.exit(0)
})
