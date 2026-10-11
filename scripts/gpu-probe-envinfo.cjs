// Environment sanity check for the GPU probes: prints Chromium's GPU feature
// status, the device list and a few env markers, so "software compositing"
// readings can be told apart from real hardware-accelerated ones.
//   npx electron scripts/gpu-probe-envinfo.cjs [--fresh] [--window] [--staged] [--hold=N]
//   --fresh    use a throwaway userData dir (rules out profile state)
//   --window   open a transparent always-on-top window with a CSS animation
//   --staged   print feature status again at t+2s and t+5s
//   --hold=N   stay alive N seconds after printing
'use strict'
const os = require('os')
const path = require('path')
const { app } = require('electron')

const holdArg = process.argv.find((a) => a.startsWith('--hold='))
const holdMs = holdArg ? Number(holdArg.split('=')[1]) * 1000 : 0
const force = process.argv.includes('--force-hw')
if (force) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
}
if (process.argv.includes('--fresh')) {
  app.setPath('userData', path.join(os.tmpdir(), 'gpu-probe-profile-' + Date.now()))
}

const statusLine = (tag) => console.log('feature status ' + tag + ': ' + JSON.stringify(app.getGPUFeatureStatus()))

const ENV_RX = /(gpu|gl_|opengl|chrome|electron|compat|detect|software|render|angle|d3d|dx)/i

app.whenReady().then(async () => {
  console.log('argv: ' + JSON.stringify(process.argv.slice(1)))
  const envSuspects = Object.keys(process.env).filter((k) => ENV_RX.test(k))
  for (const k of envSuspects) console.log('env: ' + k + '=' + String(process.env[k]).slice(0, 160))
  console.log('env session: SESSIONNAME=' + (process.env.SESSIONNAME ?? '') +
    ' COMPAT_LAYER=' + (process.env.__COMPAT_LAYER ?? '') +
    ' RDP=' + (process.env.RDP ? '1' : '0'))
  console.log('userData: ' + app.getPath('userData'))
  statusLine('t0')
  if (process.argv.includes('--window')) {
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({
      width: 554, height: 560, show: true, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: true,
      webPreferences: { contextIsolation: true },
    })
    win.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="margin:0;background:transparent">' +
      '<div style="position:absolute;left:10px;top:10px;width:500px;height:500px;' +
      'background:rgba(12,24,58,0.82);border-radius:18px;' +
      'animation: x 3.4s linear infinite alternate"></div>' +
      '<span style="position:absolute;left:30px;top:30px;color:#f2c14e">probe window</span>' +
      '<style>@keyframes x{from{transform:translateX(0)}to{transform:translateX(24px)}}</style></body>'))
    await new Promise((r) => setTimeout(r, 1500))
    console.log('window open, shown=' + win.isVisible())
  }
  if (process.argv.includes('--staged')) {
    await new Promise((r) => setTimeout(r, 2000))
    statusLine('t2')
    await new Promise((r) => setTimeout(r, 3000))
    statusLine('t5')
  }
  const info = await app.getGPUInfo('complete').catch((e) => ({ error: String(e) }))
  console.log('info keys: ' + JSON.stringify(Object.keys(info ?? {})))
  if (info?.logMessages) for (const m of info.logMessages.slice(-12)) console.log('gpu log: ' + JSON.stringify(m))
  const devs = info?.gpuDevice ?? []
  for (const d of devs) console.log('device: ' + JSON.stringify({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, deviceString: d.deviceString ?? '' }))
  console.log('aux: ' + JSON.stringify({
    glRenderer: info?.auxAttributes?.glRenderer,
    glVendor: info?.auxAttributes?.glVendor,
    glResetNotificationStrategy: Boolean(info?.auxAttributes?.glResetNotificationStrategy),
    inProcessGpu: info?.auxAttributes?.inProcessGpu,
  }))
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs))
  app.exit(0)
}).catch((err) => { console.error(err); app.exit(1) })
