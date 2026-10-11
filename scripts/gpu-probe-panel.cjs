// GPU probe: what the open panel costs while a turn runs, one ingredient at a
// time. Renders a faithful copy of the running panel (live label sweep, status
// dot pulse, working dots, cluster/thought/turn-stats pulses, plus a simulated
// streaming paragraph that grows at the app's 20 Hz snapshot cadence) inside a
// real transparent always-on-top Electron window, then reads
// app.getAppMetrics() GPU-process CPU% per variant. Variants are applied by
// body class; the panel stylesheet itself is injected unmodified from
// src/renderer/panel.css.
//
//   npx electron scripts/gpu-probe-panel.cjs                 (full run, ~10 min)
//   npx electron scripts/gpu-probe-panel.cjs --configs=compact --reps=2 --ms=4000
//
// Sampling protocol: per sample, apply variant -> 1.3 s warm-up -> prime read
// (getAppMetrics) -> pause MS ms -> read. The value is the GPU process' CPU%
// over the pause window, i.e. percent of one core. Reps are interleaved
// per config; medians are reported. Ambient system CPU busy% is recorded for
// each sample so background load (the boss's running pet) stays visible.
'use strict'
const { app, BrowserWindow, screen } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CSS = readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.css'), 'utf8')
const CACHE = path.join(ROOT, '.cache')

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=')
  return [k, v === undefined ? true : v]
}))
const SAMPLE_MS = Number(argv.ms ?? 5000)
const REPS = Number(argv.reps ?? 3)
const CONFIG_FILTER = argv.configs ? String(argv.configs).split(',') : undefined
const VARIANT_FILTER = argv.variants ? String(argv.variants).split(',') : undefined
// How many finished messages sit above the live turn — the real panel's feed
// is long; this is the variable under test for the content-size hypothesis.
const HISTORY = Number(argv.history ?? 0)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Scene: a faithful slice of a running panel. Markup mirrors panel.tsx /
// working-indicator.tsx / turn-stats.tsx / work-cluster.tsx / thinking-item.tsx
// so the same panel.css rules land on the same elements.
// ---------------------------------------------------------------------------
const STREAM_TEXT = Array.from({ length: 48 }, (_, i) =>
  `第${i + 1}段：这一句用来模拟流式回答里不断增长的正文，面板每 50 毫秒收到一次增量，文字在段落里逐字加长并可能换行。`).join('')

function historyHtml(count) {
  let html = ''
  for (let i = 0; i < count; i++) {
    const long = i % 3 === 0
    const para = '把这段再核对一遍，接口优先。'
    const reply = '这一批改动都验证过了，下面把结论按块列出来。'
    html += `
          <div class="panel-event panel-event-user">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">你</span><time class="panel-event-time">17:${String(i % 60).padStart(2, '0')}</time></div>
            <div class="panel-event-body"><p>第 ${i} 条：${para.repeat(2 + (i % 4))}</p></div>
          </div>
          <article class="panel-event panel-event-assistant is-run">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">鲸</span></div>
            <div class="panel-event-body">
              <div class="panel-markdown">
                ${long ? `<p>${reply.repeat(4)}</p><p>${('第 ' + i + ' 条结尾句，测完就收工。').repeat(3)}</p>` : `<p>第 ${i} 条回复，短一些。</p>`}
                ${long ? `<div class="panel-code-block"><pre>${('const audit' + i + ' = run(' + i + ')  // 第 ' + i + ' 条记录\n').repeat(4)}</pre></div>` : ''}
              </div>
              ${long ? `<details class="panel-tool-activity"><summary><svg class="panel-tool-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5 3 10l5 5"/><path d="m12 5 5 5-5 5"/></svg><code>执行命令</code><span class="panel-tool-argument">npm run step-${i}</span><span class="panel-tool-result is-done" aria-hidden="true">✓</span></summary></details>` : ''}
            </div>
          </article>`
  }
  return html
}

function sceneHtml({ expanded, history = 0 }) {
  const bubbleCls = `panel-bubble is-composing${expanded ? ' is-expanded' : ''}`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>gpu-probe</title></head><body>
<div id="stage">
  <section class="${bubbleCls}" aria-label="交互气泡">
    <button type="button" class="panel-expand-toggle panel-window-action" aria-label="放大"><svg viewBox="0 0 20 20"><path d="M8 4H4v4M12 4h4v4M16 12v4h-4M4 12v4h4"/></svg></button>
    <button type="button" class="panel-window-close panel-window-action" aria-label="关闭"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
    <section class="panel-workspace">
      <header class="panel-chat-header ${expanded ? 'is-browser' : 'is-numeric'}">
        <button type="button" class="panel-library-toggle" aria-label="会话菜单"><svg viewBox="0 0 20 20"><path d="M4 5h12M4 10h12M4 15h8"/></svg></button>
        <nav class="panel-quick-tabs" aria-label="会话快捷切换">
          <button type="button" class="panel-quick-tab is-current"><i class="panel-task-dot panel-task-dot-executing" aria-hidden="true"></i><span class="panel-quick-tab-label">1</span></button>
          <button type="button" class="panel-quick-tab"><i class="panel-task-dot panel-task-dot-done" aria-hidden="true"></i><span class="panel-quick-tab-label">2</span></button>
          <button type="button" class="panel-quick-tab"><i class="panel-task-dot" aria-hidden="true"></i><span class="panel-quick-tab-label">3</span></button>
          <button type="button" class="panel-quick-tab panel-quick-tab-new" aria-label="新建会话"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></button>
        </nav>
      </header>
      <div class="panel-status-row">
        <span class="panel-status panel-status-executing" role="status"><i></i><span class="panel-live-label">正在执行</span></span>
      </div>
      <div class="panel-feed-wrap">
        <div class="panel-feed" id="feed">
${historyHtml(history)}
          <div class="panel-event panel-event-user">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">你</span><time class="panel-event-time">17:50</time></div>
            <div class="panel-event-body"><p>帮我把这个脚本跑一遍，看看输出对不对</p></div>
          </div>
          <div class="panel-turn">
            <article class="panel-event panel-event-assistant is-run">
              <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">鲸</span><time class="panel-event-time">17:50</time></div>
              <div class="panel-event-body">
                <details class="panel-cluster is-running" open>
                  <summary class="panel-cluster-summary">
                    <svg class="panel-cluster-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4.8 5.2 5.2L8 15.2"/></svg>
                    <span class="panel-cluster-facts"><span>用时 00:12</span></span>
                    <span class="panel-cluster-state is-running" aria-hidden="true">…</span>
                  </summary>
                  <div class="panel-cluster-body">
                    <details class="panel-thought is-streaming">
                      <summary>
                        <svg class="panel-thought-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M9.5 3.2c.9 3.1 1.7 3.9 4.8 4.8-3.1.9-3.9 1.7-4.8 4.8-.9-3.1-1.7-3.9-4.8-4.8 3.1-.9 3.9-1.7 4.8-4.8Z"/><path d="M15 12.3c.4 1.5.8 1.9 2.3 2.3-1.5.4-1.9.8-2.3 2.3-.4-1.5-.8-1.9-2.3-2.3 1.5-.4 1.9-.8 2.3-2.3Z"/></svg>
                        <span class="panel-thought-label panel-live-label">思考中</span>
                        <span class="panel-thought-time" id="thought-time">12 秒</span>
                        <span class="panel-thought-state is-running" aria-hidden="true">…</span>
                      </summary>
                    </details>
                    <details class="panel-tool-activity is-running">
                      <summary>
                        <svg class="panel-tool-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5 3 10l5 5"/><path d="m12 5 5 5-5 5"/></svg>
                        <code class="panel-live-label">执行命令</code>
                        <span class="panel-tool-argument">npm run test</span>
                        <span class="panel-tool-result is-running" aria-hidden="true">…</span>
                      </summary>
                    </details>
                  </div>
                </details>
                <div class="panel-markdown">
                  <p>好，我先看一下脚本内容，然后按顺序把测试跑一遍。</p>
                  <p id="stream-p">正在检查脚本内容……</p>
                </div>
              </div>
            </article>
            <div class="panel-turn-stats" role="status">
              <span class="panel-turn-stats-dot is-running" aria-hidden="true"></span>
              <span class="panel-turn-usage" tabindex="0">1.2k token</span>
              <span class="panel-turn-usage panel-turn-tools" tabindex="0">3 次工具</span>
            </div>
          </div>
          <div class="panel-working" role="status">
            <span class="panel-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="panel-working-text">正在执行工具</span>
            <span class="panel-working-time" id="work-time">36 秒</span>
          </div>
        </div>
      </div>
      <div class="panel-compose-dock is-open">
        <form class="panel-composer">
          <button type="button" class="panel-composer-collapse" aria-label="收起输入框"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
          <div class="panel-composer-inputrow"><textarea rows="1" style="height:22px" aria-label="输入消息" placeholder="输入消息…"></textarea></div>
          <div class="panel-composer-toolbar">
            <button type="button" class="panel-model-button" aria-label="模型与上下文"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5v7M6.5 10h7"/></svg></button>
            <button type="button" class="panel-tool-button panel-effort-button is-on" aria-label="思考强度：高"><svg viewBox="0 0 20 20"><path d="M10 3v14M4 8l6-5 6 5"/></svg><span class="panel-effort-badge">高</span></button>
            <div class="panel-context-wrap">
              <button type="button" class="panel-context-meter is-known" aria-label="上下文"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" pathLength="100" stroke="rgba(169,199,250,.22)"/><circle class="panel-context-progress" cx="18" cy="18" r="16" pathLength="100" stroke-dasharray="42 58"/></svg></button>
            </div>
            <button type="button" class="panel-send" aria-label="停止任务"><span class="panel-stop-square" aria-hidden="true"></span></button>
          </div>
        </form>
      </div>
    </section>
  </section>
</div>
<script>
const STREAM_TEXT = ${JSON.stringify(STREAM_TEXT)};
const PRE = '正在检查脚本内容……';
let streamTimer = null, clockTimer = null, rafOn = false, rafCount = 0, rafRunning = false;
function rafLoop() { if (!rafOn) { rafRunning = false; return; } rafCount++; requestAnimationFrame(rafLoop); }
window.__rafOn = (v) => {
  const on = !!v;
  rafCount = 0;
  if (on && !rafRunning) { rafRunning = true; rafOn = true; requestAnimationFrame(rafLoop); }
  else if (!on) { rafOn = false; rafRunning = false; }
};
window.__rafRead = () => rafCount;
function tick() {
  const p = document.getElementById('stream-p');
  if (!p) return;
  const next = window.__streamN = (window.__streamN ?? PRE.length) + 3;
  p.textContent = STREAM_TEXT.slice(0, Math.min(next, STREAM_TEXT.length));
  const feed = document.getElementById('feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}
window.__apply = (variant, stream, raf) => {
  document.body.className = variant;
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  window.__streamN = PRE.length;
  const p = document.getElementById('stream-p');
  if (p) p.textContent = PRE;
  const feed = document.getElementById('feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
  window.__rafOn(raf);
  if (stream) {
    streamTimer = setInterval(tick, 50);
    clockTimer = setInterval(() => {
      const w = document.getElementById('work-time'), t = document.getElementById('thought-time');
      if (w) w.textContent = (30 + Math.floor(Date.now() / 1000) % 60) + ' 秒';
      if (t) t.textContent = (10 + Math.floor(Date.now() / 1000) % 60) + ' 秒';
    }, 1000);
  }
};
window.__animState = () => {
  const all = document.getAnimations();
  const running = all.filter((a) => a.playState === 'running');
  const names = [...new Set(running.map((a) => (a.animationName || '?') + (a.effect && a.effect.pseudoElement ? a.effect.pseudoElement : '')))];
  return { total: all.length, running: running.length, names };
};
</script>
</body></html>`
}

// ---------------------------------------------------------------------------
// Variant CSS. `v-only` + keep-classes = kill everything then re-enable one
// ingredient; `v-<ablation>` = full recipe minus one ingredient.
// ---------------------------------------------------------------------------
const KILL_ALL = ['v-static', 'v-streamonly', 'v-only']
  .flatMap((k) => [`body.${k} *`, `body.${k} *::before`, `body.${k} *::after`])
  .join(', ') + ' { animation: none !important; }\n'

const VARIANT_CSS = `
${KILL_ALL}
body.v-only-statusdot .panel-status-executing i { animation: voice-pulse 1.2s ease-in-out infinite !important; }
body.v-only-sweep .panel-live-label::before { animation: panel-live-sweep 3.4s ease-in-out infinite !important; }
body.v-only-sweep .panel-live-label::after { animation: panel-live-sweep 3.4s ease-in-out infinite !important; }
body.v-only-dots .panel-working-dots i { animation: panel-working-bounce 1.2s ease-in-out infinite !important; }
body.v-only-dots .panel-working-dots i:nth-child(2) { animation-delay: .18s !important; }
body.v-only-dots .panel-working-dots i:nth-child(3) { animation-delay: .36s !important; }
body.v-nosweep .panel-live-label::before, body.v-nosweep .panel-live-label::after { animation: none !important; }
body.v-noafter .panel-live-label::after { display: none !important; }
body.v-nobefore .panel-live-label::before { display: none !important; }
body.v-nolivelabel .panel-live-label { animation: none !important; background-image: none !important; -webkit-text-fill-color: var(--panel-live-base) !important; text-shadow: none !important; }
body.v-nolivelabel .panel-live-label::before, body.v-nolivelabel .panel-live-label::after { display: none !important; }
body.v-nostatusdot .panel-status-executing i { animation: none !important; }
body.v-noworkdots .panel-working-dots i { animation: none !important; }
body.v-nothoughtstate .panel-thought-state.is-running { animation: none !important; }
body.v-noturndot .panel-turn-stats-dot.is-running { animation: none !important; }
body.v-noclusterstate .panel-cluster-state.is-running { animation: none !important; }
body.v-novoicepulse .panel-thought-state.is-running, body.v-novoicepulse .panel-turn-stats-dot.is-running,
body.v-novoicepulse .panel-cluster-state.is-running, body.v-novoicepulse .panel-status-executing i { animation: none !important; }
body.v-contain .panel-feed { contain: paint; }
body.v-willchange .panel-working-dots i, body.v-willchange .panel-turn-stats-dot.is-running,
body.v-willchange .panel-cluster-state.is-running, body.v-willchange .panel-thought-state.is-running,
body.v-willchange .panel-status-executing i { will-change: transform, opacity; }
body.v-willchange .panel-live-label::before, body.v-willchange .panel-live-label::after { will-change: transform; }
`

const VARIANTS = [
  { name: 'static', stream: false, raf: false, note: 'no animations at all (baseline)' },
  { name: 'anims', stream: false, raf: true, note: 'all panel animations, no text stream' },
  { name: 'full', stream: true, raf: true, note: 'all animations + 20 Hz streaming text (replication)' },
  { name: 'streamonly', stream: true, raf: false, note: 'no animations, streaming text only' },
  { name: 'only-statusdot', stream: false, raf: true, note: 'only the status dot pulse' },
  { name: 'only-sweep', stream: false, raf: true, note: 'only the live-label sweeps (both pseudos)' },
  { name: 'only-dots', stream: false, raf: true, note: 'only the working-dots bounce' },
  { name: 'nosweep', stream: true, raf: true, note: 'full minus sweep motion (bars stay painted)' },
  { name: 'noafter', stream: true, raf: true, note: 'full minus ::after sheen (layer removed)' },
  { name: 'nobefore', stream: true, raf: true, note: 'full minus ::before bar (layer removed)' },
  { name: 'nolivelabel', stream: true, raf: true, note: 'full minus live-label recipe entirely' },
  { name: 'nostatusdot', stream: true, raf: true, note: 'full minus status dot pulse' },
  { name: 'noworkdots', stream: true, raf: true, note: 'full minus working-dots bounce' },
  { name: 'nothoughtstate', stream: true, raf: true, note: 'full minus thought-state pulse' },
  { name: 'noturndot', stream: true, raf: true, note: 'full minus turn-stats dot pulse' },
  { name: 'noclusterstate', stream: true, raf: true, note: 'full minus cluster-state pulse' },
  { name: 'novoicepulse', stream: true, raf: true, note: 'full minus all voice-pulse dots' },
  { name: 'contain', stream: true, raf: true, note: 'full + contain:paint on the feed' },
  { name: 'willchange', stream: true, raf: true, note: 'full + will-change on animated layers' },
]

function windowConfigs(work) {
  const expandedH = Math.max(768, Math.min(1100, work.height))
  return [
    { id: 'compact', width: 554, height: 560, transparent: true, onTop: true, expanded: false, variants: 'all', reps: REPS },
    { id: 'expanded', width: 554, height: expandedH, transparent: true, onTop: true, expanded: true, variants: ['static', 'full'], reps: REPS },
    { id: 'tight', width: 376, height: 380, transparent: true, onTop: true, expanded: false, tight: true, variants: ['static', 'full'], reps: REPS },
    { id: 'wide', width: 1108, height: 560, transparent: true, onTop: true, expanded: false, variants: ['static', 'full'], reps: REPS },
    { id: 'opaque', width: 554, height: 560, transparent: false, onTop: true, expanded: false, variants: ['static', 'full'], reps: REPS },
    { id: 'notop', width: 554, height: 560, transparent: true, onTop: false, expanded: false, variants: ['static', 'full'], reps: REPS },
    // The real app clips its single window to two rectangles with
    // win.setShape (avatar + bubble) — Windows shapes windows via
    // SetWindowRgn, which DWM historically composites on a slower path.
    // Same scene, same window options, one win.setShape call apart.
    { id: 'shaped', width: 554, height: 560, transparent: true, onTop: true, expanded: false, variants: ['static', 'full'], reps: REPS, shaped: true },
  ]
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
function readUsage() {
  const metrics = app.getAppMetrics()
  const sum = (type) => metrics.filter((m) => m.type === type).reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0)
  const gpuProc = metrics.find((m) => m.type === 'GPU')
  return {
    gpu: sum('GPU'),
    tab: sum('Tab'),
    gpuWakeups: gpuProc?.cpu?.idleWakeupsPerSecond ?? 0,
  }
}

function sysTimes() {
  let total = 0, idle = 0
  for (const c of os.cpus()) {
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    idle += c.times.idle
  }
  return { total, idle }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function measureSample(win, variant) {
  await win.webContents.executeJavaScript(`window.__apply(${JSON.stringify(variant.name === 'streamonly' ? 'v-streamonly' : variant.name === 'static' ? 'v-static' : variant.name.startsWith('only-') ? 'v-only v-' + variant.name : 'v-' + variant.name)}, ${variant.stream}, ${variant.raf})`)
  await sleep(1300)
  const t0 = { usage: readUsage(), sys: sysTimes(), frames: variant.raf ? await win.webContents.executeJavaScript('window.__rafRead()') : null, at: Date.now() }
  await sleep(SAMPLE_MS)
  const t1 = { usage: readUsage(), sys: sysTimes(), frames: variant.raf ? await win.webContents.executeJavaScript('window.__rafRead()') : null, at: Date.now() }
  const wall = (t1.at - t0.at) / 1000
  const anims = await win.webContents.executeJavaScript('window.__animState()')
  return {
    gpu: t1.usage.gpu,
    tab: t1.usage.tab,
    gpuWakeups: t1.usage.gpuWakeups,
    at: t1.at,
    fps: t1.frames === null ? null : Number(((t1.frames - t0.frames) / wall).toFixed(1)),
    sysBusy: Number((100 * (1 - (t1.sys.idle - t0.sys.idle) / Math.max(1, t1.sys.total - t0.sys.total))).toFixed(1)),
    anims,
  }
}

async function runConfig(cfg, pageHtml, pathOverrideCss) {
  const bounds = { x: 40, y: cfg.height > 700 ? 0 : 40, width: cfg.width, height: cfg.height }
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    show: false,
    transparent: cfg.transparent,
    backgroundColor: cfg.transparent ? '#00000000' : '#0b1a3e',
    hasShadow: false,
    alwaysOnTop: cfg.onTop,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: false, backgroundThrottling: false },
  })
  let variants = cfg.variants === 'all' ? VARIANTS : VARIANTS.filter((v) => cfg.variants.includes(v.name))
  if (VARIANT_FILTER) variants = variants.filter((v) => VARIANT_FILTER.includes(v.name))
  // A second window built right after the previous one is destroyed can race
  // the GPU process and fail the data-URL load with ERR_FAILED; retry briefly.
  for (let attempt = 1; ; attempt++) {
    try { await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml)); break }
    catch (error) { if (attempt >= 3) throw error; await sleep(700) }
  }
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(`
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    #stage { position: relative; width: 100%; height: 100%; }
    ${cfg.tight ? '.panel-bubble { bottom: 10px; height: 358px; }' : ''}
    ${pathOverrideCss}
  `)
  await win.webContents.insertCSS(VARIANT_CSS)
  win.showInactive()
  if (cfg.shaped) {
    win.setShape([
      { x: cfg.width - 168, y: cfg.height - 186, width: 160, height: 180 },
      { x: cfg.width - 366, y: cfg.height - 550, width: 356, height: 365 },
    ])
  }
  await sleep(800)
  console.log(`  gpuPid ${app.getAppMetrics().find((m) => m.type === 'GPU')?.pid ?? 'null'}`)
  const reduce = await win.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  const samples = []
  for (let rep = 1; rep <= cfg.reps; rep++) {
    for (const variant of variants) {
      const s = await measureSample(win, variant)
      samples.push({ config: cfg.id, variant: variant.name, rep, ...s })
      console.log(`  [${new Date().toISOString().slice(11, 19)}] ${cfg.id}/${variant.name} rep${rep}: gpu ${s.gpu.toFixed(2)}%  tab ${s.tab.toFixed(1)}%  fps ${s.fps ?? '-'}  sys ${s.sysBusy}%  anims ${s.anims.running}/${s.anims.total}`)
    }
  }
  // one screenshot of the full recipe for eyeballing, after sampling is done
  await win.webContents.executeJavaScript(`window.__apply('v-full', false, false)`)
  await sleep(500)
  const shot = path.join(os.tmpdir(), `gpu-probe-${cfg.id}.png`)
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log(`  shot: ${shot}`)
  win.destroy()
  await sleep(700)
  return { samples, reduce }
}

app.whenReady().then(async () => {
  mkdirSync(CACHE, { recursive: true })
  const display = screen.getPrimaryDisplay()
  const work = display.workAreaSize
  console.log(`display: workArea ${work.width}x${work.height} @${display.scaleFactor}x  bounds ${JSON.stringify(display.bounds)}`)
  // NOTE: right after startup this can still be the provisional "disabled_software"
  // state Chromium reports before GPU info has arrived (verified on this machine: it
  // flips to all-"enabled" ~2 s later, see gpuStatusSettled in the raw JSON).
  const gpuStatus = app.getGPUFeatureStatus()
  app.on('gpu-info-update', () => {
    try { console.log('gpu-info-update: ' + JSON.stringify(app.getGPUFeatureStatus())) } catch {}
  })
  const gpuInfo = await app.getGPUInfo('basic').catch(() => null)
  const gpuName = gpuInfo?.gpuDevice?.map?.((d) => `${d.vendorId}:${d.deviceId}`).join(' ') ?? 'n/a'
  console.log(`gpu feature status: ${JSON.stringify(gpuStatus)}`)
  console.log(`gpu devices (vendor:device): ${gpuName}`)
  console.log(`sample window ${SAMPLE_MS} ms, reps ${REPS}`)

  const all = { meta: { sampleMs: SAMPLE_MS, reps: REPS, display: { workArea: work, scaleFactor: display.scaleFactor }, gpuStatus, startedAt: new Date().toISOString() }, samples: [] }
  try {
    for (const cfg of windowConfigs(work)) {
      if (CONFIG_FILTER && !CONFIG_FILTER.includes(cfg.id)) continue
      console.log(`\n## ${cfg.id} (${cfg.width}x${cfg.height} transparent=${cfg.transparent} alwaysOnTop=${cfg.onTop})`)
      const { samples, reduce } = await runConfig(cfg, sceneHtml({ expanded: cfg.expanded, history: HISTORY }), '')
      all.samples.push(...samples)
      if (reduce) console.log('  WARNING: prefers-reduced-motion is ON for this machine; animations were killed by the media block')
    }
  } catch (err) {
    console.error('probe failed:', err)
    all.error = String(err && err.stack || err)
  }
  // Settled (post-render) GPU feature status — the trustworthy one. The GPU
  // process exists by now (it did not yet when this script started measuring
  // that early, so its pid is captured here for the external engine tap).
  all.meta.gpuStatusSettled = app.getGPUFeatureStatus()
  all.meta.gpuPid = app.getAppMetrics().find((m) => m.type === 'GPU')?.pid ?? null
  console.log('gpu feature status (settled): ' + JSON.stringify(all.meta.gpuStatusSettled))
  // Aggregate medians per config/variant
  const agg = {}
  for (const s of all.samples) {
    const key = `${s.config}/${s.variant}`
    ;(agg[key] ??= { config: s.config, variant: s.variant, gpu: [], tab: [], fps: [], sysBusy: [] })
    agg[key].gpu.push(s.gpu); agg[key].tab.push(s.tab); if (s.fps !== null) agg[key].fps.push(s.fps); agg[key].sysBusy.push(s.sysBusy)
  }
  all.medians = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, {
    config: v.config, variant: v.variant,
    gpu: Number(median(v.gpu).toFixed(2)), tab: Number(median(v.tab).toFixed(1)),
    fps: v.fps.length ? Number(median(v.fps).toFixed(1)) : null,
    sysBusy: Number(median(v.sysBusy).toFixed(1)), reps: v.gpu.length,
    gpuAll: v.gpu.map((x) => Number(x.toFixed(2))),
  }]))
  const outFile = path.join(CACHE, String(argv.out ?? 'gpu-probe-raw.json'))
  writeFileSync(outFile, JSON.stringify(all, null, 2))
  console.log(`\nraw data: ${outFile}`)

  console.log('\n== medians (gpu% of one core, GPU process) ==')
  const byConfig = {}
  for (const m of Object.values(all.medians)) (byConfig[m.config] ??= []).push(m)
  for (const [cfg, rows] of Object.entries(byConfig)) {
    console.log(`-- ${cfg}`)
    for (const r of rows) console.log(`   ${r.variant.padEnd(15)} gpu ${String(r.gpu).padStart(5)}%  tab ${String(r.tab).padStart(4)}%  fps ${r.fps ?? '-'}  sys ${r.sysBusy}%  reps [${r.gpuAll.join(', ')}]`)
  }
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
