import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeEnvironment, enhancedPath, extraBinaryPaths, findClaudeExecutable } from '../src/main/claude-code'

describe('Claude engine resolution', () => {
  it('prefers the engine that ships inside the app over any system install', () => {
    // This repository carries the SDK's native folder in node_modules, so
    // resolution must land inside the project — that is the copy getting
    // packaged, and the app's portability depends on it winning.
    const found = findClaudeExecutable({ ...process.env, DESKTOP_PET_CLAUDE_EXE: undefined })
    expect(found).toBeTruthy()
    expect(found!.toLowerCase()).toContain(path.join('node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude.exe').toLowerCase())
  })

  it('still lets the explicit environment override win', () => {
    const found = findClaudeExecutable({ ...process.env, DESKTOP_PET_CLAUDE_EXE: process.execPath })
    expect(found).toBe(process.execPath)
  })
})

describe('Claude Code child environment', () => {
  it('overrides other provider credentials only for the child process', () => {
    const parent = {
      ANTHROPIC_API_KEY: 'other-provider-key',
      ANTHROPIC_BASE_URL: 'https://elsewhere.example',
      DEEPSEEK_API_KEY: 'user-key',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1'
    }
    const child = claudeEnvironment(parent, { apiKey: 'deepseek-key', configDir: 'D:\\DesktopPetProject\\data\\claude' })
    expect(child.ANTHROPIC_API_KEY).toBeUndefined()
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe('deepseek-key')
    expect(child.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(child.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70')
    expect(child.CLAUDE_CONFIG_DIR).toBe('D:\\DesktopPetProject\\data\\claude')
    expect(child.DISABLE_AUTO_COMPACT).toBeUndefined()
    expect(child.DISABLE_COMPACT).toBeUndefined()
    expect(parent.ANTHROPIC_BASE_URL).toBe('https://elsewhere.example')
    expect(parent.DISABLE_AUTO_COMPACT).toBe('1')
  })

  it('hands the child the enhanced PATH without touching the parent', () => {
    const parent = {
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\tester',
      PATH: 'C:\\Windows'
    }
    const child = claudeEnvironment(parent, { apiKey: 'test-key' })
    expect(child.PATH?.startsWith(`C:\\Windows${';'}`)).toBe(true)
    expect(child.PATH).toContain(`${parent.APPDATA}\\npm`)
    expect(parent.PATH).toBe('C:\\Windows')
  })
})

describe('provider environment', () => {
  it('injects the profile model names and the host-managed marker', () => {
    const child = claudeEnvironment({}, { apiKey: 'k', baseUrl: 'https://example.test/anthropic', model: 'm1', smallModel: 'm0' })
    expect(child.ANTHROPIC_BASE_URL).toBe('https://example.test/anthropic')
    expect(child.ANTHROPIC_MODEL).toBe('m1')
    expect(child.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('m0')
    expect(child.CLAUDE_CODE_SUBAGENT_MODEL).toBe('m0')
    expect(child.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
  })

  it('applies KEY=VALUE lines from the advanced field last, ignoring comments and malformed lines', () => {
    const child = claudeEnvironment({ PATH: 'C:\\Windows' }, {
      apiKey: 'k',
      extraEnv: '# note\nANTHROPIC_CUSTOM_HEADERS=X-Y: 1\nbroken line\n=oops\nPATH=C:\\Custom'
    })
    expect(child.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Y: 1')
    // Explicit lines win over the built-ins, PATH included.
    expect(child.PATH).toBe('C:\\Custom')
  })
})

describe('CLI discovery', () => {
  const baseEnv = {
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\tester',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    ProgramData: 'C:\\ProgramData'
  }

  it('enumerates the install locations a shortcut PATH misses', () => {
    const paths = extraBinaryPaths(baseEnv)
    expect(paths).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm')
    expect(paths).toContain('C:\\Users\\tester\\.local\\bin')
    expect(paths).toContain('C:\\Users\\tester\\.volta\\bin')
    expect(paths).toContain('C:\\Users\\tester\\.bun\\bin')
    expect(paths).toContain('C:\\Users\\tester\\scoop\\shims')
    expect(paths).toContain('C:\\Users\\tester\\AppData\\Local\\pnpm')
    expect(paths).toContain('C:\\Users\\tester\\AppData\\Local\\Programs\\claude')
    expect(paths).toContain('C:\\Program Files\\nodejs')
    expect(paths).toContain('C:\\Program Files\\Git\\cmd')
    expect(paths).toContain('C:\\Program Files\\Git\\bin')
    expect(paths).toContain('C:\\ProgramData\\chocolatey\\bin')
  })

  it('appends them to PATH without duplicates and keeps the original order', () => {
    const env = { ...baseEnv, PATH: 'C:\\Windows;C:\\Program Files\\nodejs' }
    const parts = enhancedPath(env).split(';')
    expect(parts[0]).toBe('C:\\Windows')
    expect(parts[1]).toBe('C:\\Program Files\\nodejs')
    expect(parts.filter((part) => part.toLowerCase() === 'c:\\program files\\nodejs')).toHaveLength(1)
    expect(parts).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm')
  })

  it('prefers the explicit override, falls back to the bundled engine, and only trusts real files', () => {
    expect(findClaudeExecutable({ ...baseEnv, DESKTOP_PET_CLAUDE_EXE: process.execPath })).toBe(process.execPath)
    // A broken override falls through — down to the engine bundled inside the
    // app, which this repository carries in node_modules.
    const bundled = findClaudeExecutable({})
    expect(bundled).toContain(path.join('node_modules', '@anthropic-ai'))
    expect(findClaudeExecutable({ ...baseEnv, DESKTOP_PET_CLAUDE_EXE: 'C:\\nowhere\\claude.exe' })).toBe(bundled)
  })
})
