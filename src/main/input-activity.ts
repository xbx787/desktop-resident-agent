import type { InputActivity } from '../shared/input-activity'
import { createInputActivity, publicInputActivity, reduceInputActivity, type InputActivityEvent } from '../shared/input-activity'

let started = false
let state = createInputActivity()
let emitTimer: NodeJS.Timeout | undefined
let clearTimer: NodeJS.Timeout | undefined
let hook: { stop: () => void } | undefined

/** 面板显示的键鼠快照变化时回调；节流到约 25fps。 */
function scheduleEmit(onChange: (activity: InputActivity) => void): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = undefined
    onChange(publicInputActivity(state))
  }, 40)
}

/**
 * 启动全局键鼠监听（仅 Windows）。钩子失败不影响应用：面板就不显示这栏。
 * 事件归约在 shared/input-activity 里，纯函数可单测。
 */
export function startInputActivity(onChange: (activity: InputActivity) => void): void {
  if (started || process.platform !== 'win32') return
  try {
    // 原生模块不能被打进 bundle，保留 require 由打包后的 node_modules 提供。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi') as { uIOhook: { on: Function; start: Function; stop: () => void } }
    const uIOhook = mod.uIOhook
    const push = (event: InputActivityEvent): void => {
      state = reduceInputActivity(state, event, Date.now())
      if (event.type === 'wheel' || event.type === 'mousedown' || event.type === 'mouseup') {
        if (clearTimer) clearTimeout(clearTimer)
        clearTimer = setTimeout(() => {
          clearTimer = undefined
          if (state.wheel || state.middleDrag) {
            state = { ...state, wheel: null, middleDrag: state.mouse.middle ? state.middleDrag : false }
            scheduleEmit(onChange)
          }
        }, 650)
      }
      scheduleEmit(onChange)
    }
    uIOhook.on('keydown', (event: { keycode: number }) => push({ type: 'keydown', keycode: event.keycode }))
    uIOhook.on('keyup', (event: { keycode: number }) => push({ type: 'keyup', keycode: event.keycode }))
    uIOhook.on('mousedown', (event: { button: number; x: number; y: number }) => push({ type: 'mousedown', button: event.button, x: event.x, y: event.y }))
    uIOhook.on('mouseup', (event: { button: number; x: number; y: number }) => push({ type: 'mouseup', button: event.button, x: event.x, y: event.y }))
    uIOhook.on('mousemove', (event: { x: number; y: number }) => push({ type: 'mousemove', x: event.x, y: event.y }))
    uIOhook.on('wheel', (event: { rotation: number }) => push({ type: 'wheel', rotation: event.rotation }))
    uIOhook.start()
    hook = uIOhook
    started = true
  } catch (error) {
    console.warn('[input-activity] global hook unavailable:', error)
  }
}

export function stopInputActivity(): void {
  if (emitTimer) clearTimeout(emitTimer)
  if (clearTimer) clearTimeout(clearTimer)
  emitTimer = undefined
  clearTimer = undefined
  try { hook?.stop() } catch { /* already stopped */ }
  hook = undefined
  started = false
}
