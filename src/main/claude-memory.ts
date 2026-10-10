import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Starter content for the engine's memory file, written once on first launch
 *  when none exists. It is the user's file from then on. */
export const CLAUDE_MEMORY_SEED = `# 小鲸的个人设定

这个文件会随每次对话一起交给小鲸，用来放你的长期偏好和约定。
直接改、保存就好，会很快在之后的对话里生效；称呼与头像在设置窗口里改。

## 喜好与约定
- 例：回答先给结论，再给理由
- 例：代码注释统一用中文

## 请长期记住
- 例：我的项目放在 D:\\Projects
`

/** Materializes the memory file under the engine's config directory when it
 *  is absent, so a fresh install ships with a personal-settings file the user
 *  can edit — one that travels with the app's data directory to any machine.
 *  Never overwrites an existing file: after the first launch it is the
 *  user's. */
export function seedClaudeMemory(configDir: string): void {
  try {
    const target = path.join(configDir, 'CLAUDE.md')
    if (existsSync(target)) return
    mkdirSync(configDir, { recursive: true })
    writeFileSync(target, CLAUDE_MEMORY_SEED, 'utf8')
  } catch {
    // Best effort: the app runs fine without the file.
  }
}
