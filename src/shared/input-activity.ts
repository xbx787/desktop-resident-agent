/** 全局键鼠活动的纯数据模型：主进程把系统钩子事件归约成这个快照，
 *  面板只负责显示。这里是纯函数，方便单测。 */

export interface InputActivityMouse {
  left: boolean
  middle: boolean
  right: boolean
}

export interface InputActivity {
  /** 当前按住的键，按按下顺序；松开后移除。 */
  keys: string[]
  /** 最近按下的组合键（先进先出，最多 3 行），每行是一组键帽。 */
  recent: string[][]
  mouse: InputActivityMouse
  /** 中键按住后发生了拖动（>4px）。 */
  middleDrag: boolean
  /** 最近的滚轮方向；由主进程定时清空。 */
  wheel: 'up' | 'down' | null
  at: number
  /** 内部状态：按下的键码，保证同名键（左右 Ctrl）能正确移除。 */
  pressed?: number[]
  /** 内部状态：中键按下时的坐标，用来判断拖动。 */
  middleOrigin?: { x: number; y: number } | null
}

export type InputActivityEvent =
  | { type: 'keydown'; keycode: number }
  | { type: 'keyup'; keycode: number }
  | { type: 'mousedown'; button: number; x: number; y: number }
  | { type: 'mouseup'; button: number; x: number; y: number }
  | { type: 'mousemove'; x: number; y: number }
  | { type: 'wheel'; rotation: number }

const MODIFIERS: Record<number, string> = {
  0x10: 'Shift',
  0x11: 'Ctrl',
  0x12: 'Alt',
  0x5b: 'Win',
  0x5c: 'Win'
}

const NAMED: Record<number, string> = {
  0x08: 'Backspace',
  0x09: 'Tab',
  0x0d: 'Enter',
  0x13: 'Pause',
  0x14: 'CapsLock',
  0x1b: 'Esc',
  0x20: 'Space',
  0x21: 'PageUp',
  0x22: 'PageDown',
  0x23: 'End',
  0x24: 'Home',
  0x25: '←',
  0x26: '↑',
  0x27: '→',
  0x28: '↓',
  0x2c: 'PrintScreen',
  0x2d: 'Insert',
  0x2e: 'Delete',
  0x90: 'NumLock',
  0x91: 'ScrollLock'
}

const PUNCTUATION: Record<number, string> = {
  0xba: ';',
  0xbb: '=',
  0xbc: ',',
  0xbd: '-',
  0xbe: '.',
  0xbf: '/',
  0xc0: '`',
  0xdb: '[',
  0xdc: '\\',
  0xdd: ']',
  0xde: "'"
}

/** 把 Windows 虚拟键码换成面板上显示的短标签。 */
export function keyLabel(code: number): string {
  if (MODIFIERS[code]) return MODIFIERS[code]
  if (NAMED[code]) return NAMED[code]
  if (PUNCTUATION[code]) return PUNCTUATION[code]
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code)
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code)
  if (code >= 0x60 && code <= 0x69) return `小键盘 ${code - 0x60}`
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`
  return `键${code}`
}

export function createInputActivity(): InputActivity {
  return {
    keys: [],
    recent: [],
    mouse: { left: false, middle: false, right: false },
    middleDrag: false,
    wheel: null,
    at: 0,
    pressed: [],
    middleOrigin: null
  }
}

function buttonName(button: number): keyof InputActivityMouse | null {
  if (button === 1) return 'left'
  if (button === 2) return 'right'
  if (button === 3) return 'middle'
  return null
}

/** 归约一次系统输入事件；返回新对象，不改原状态。 */
export function reduceInputActivity(state: InputActivity, event: InputActivityEvent, now: number): InputActivity {
  const pressed = state.pressed ?? []
  const base: InputActivity = {
    ...state,
    mouse: { ...state.mouse },
    keys: [...state.keys],
    pressed: [...pressed],
    at: now
  }
  switch (event.type) {
    case 'keydown': {
      if (!base.pressed!.includes(event.keycode)) {
        base.pressed!.push(event.keycode)
        base.keys.push(keyLabel(event.keycode))
        if (!MODIFIERS[event.keycode]) {
          // 组合键合成一行：Ctrl + C；单独的修饰键不占队列。
          const order = [0x11, 0x10, 0x12, 0x5b, 0x5c]
          const mods: string[] = []
          for (const code of order) {
            if (base.pressed!.includes(code)) {
              const label = keyLabel(code)
              if (!mods.includes(label)) mods.push(label)
            }
          }
          base.recent.push([...mods, keyLabel(event.keycode)])
          if (base.recent.length > 3) base.recent.splice(0, base.recent.length - 3)
        }
      }
      return base
    }
    case 'keyup': {
      const index = base.pressed!.indexOf(event.keycode)
      if (index >= 0) {
        base.pressed!.splice(index, 1)
        const label = keyLabel(event.keycode)
        const labelIndex = base.keys.indexOf(label)
        if (labelIndex >= 0) base.keys.splice(labelIndex, 1)
      }
      return base
    }
    case 'mousedown': {
      const name = buttonName(event.button)
      if (name) base.mouse[name] = true
      if (name === 'middle') {
        base.middleDrag = false
        base.middleOrigin = { x: event.x, y: event.y }
      }
      return base
    }
    case 'mouseup': {
      const name = buttonName(event.button)
      if (name) base.mouse[name] = false
      if (name === 'middle') {
        base.middleDrag = false
        base.middleOrigin = null
      }
      return base
    }
    case 'mousemove': {
      if (base.mouse.middle && base.middleOrigin) {
        const dx = event.x - base.middleOrigin.x
        const dy = event.y - base.middleOrigin.y
        if (dx * dx + dy * dy > 16) base.middleDrag = true
      }
      return base
    }
    case 'wheel': {
      base.wheel = event.rotation > 0 ? 'up' : 'down'
      return base
    }
    default:
      return base
  }
}

/** 面板只拿显示字段，内部键码不外发。 */
export function publicInputActivity(state: InputActivity): InputActivity {
  return {
    keys: state.keys,
    recent: state.recent,
    mouse: state.mouse,
    middleDrag: state.middleDrag,
    wheel: state.wheel,
    at: state.at
  }
}



