import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_SLASH_COMMANDS, listClaudeWorkflows, parseAppSlashCommand, resolveClaudeWorkflowPrompt } from '../src/main/claude-workflows'

const projectRoot = process.cwd()
let testRoot: string
let workspace: string
let userConfig: string

beforeEach(async () => {
  testRoot = path.join(projectRoot, '.cache', 'tests', `workflows-${randomUUID()}`)
  workspace = path.join(testRoot, 'workspace')
  userConfig = path.join(testRoot, 'user-claude')
  await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(userConfig, { recursive: true })])
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.')
  await fs.rm(testRoot, { recursive: true, force: true })
})

async function write(relativePath: string, content: string): Promise<void> {
  const target = path.join(testRoot, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

describe('Claude workflow metadata and native dispatch', () => {
  it('exposes app commands with exact dispatch and no accidental matching', () => {
    expect(APP_SLASH_COMMANDS.map((item) => item.name)).toEqual(['new', 'sessions', 'model', 'help', 'compact'])
    expect(parseAppSlashCommand('/new  方案讨论 ')).toEqual({ name: 'new', args: '方案讨论' })
    expect(parseAppSlashCommand('/COMPACT')).toEqual({ name: 'compact', args: '' })
    expect(parseAppSlashCommand('/sessions')).toEqual({ name: 'sessions', args: '' })
    expect(parseAppSlashCommand('/newer')).toBeNull()
    expect(parseAppSlashCommand('请执行 /new')).toBeNull()
  })
  it('lists commands and skills by effective name while returning no instruction body', async () => {
    await write('user-claude/commands/review.md', '---\ndescription: Legacy review\n---\nPRIVATE USER COMMAND BODY')
    await write('workspace/.claude/skills/review/SKILL.md', '---\nname: review\ndescription: "Review the current change"\n---\nPRIVATE PROJECT SKILL BODY')
    await write('user-claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: >\n  Deploy to staging\n  with checks\n---\nPRIVATE USER SKILL BODY')
    await write('workspace/.claude/skills/deploy/SKILL.md', '---\ndescription: Project deploy\n---\nPRIVATE PROJECT BODY')
    await write('workspace/.claude/commands/front/component.md', '---\ndescription: Make component\n---\nPRIVATE NESTED BODY')
    await write('workspace/.claude/skills/internal/SKILL.md', '---\nname: internal\nuser-invocable: false\ndescription: Hidden\n---\nPRIVATE BODY')

    const listed = await listClaudeWorkflows({ projectRoot: workspace, userConfigRoot: userConfig })
    expect(listed.map(({ name, kind, source, description }) => ({ name, kind, source, description }))).toEqual([
      { name: 'deploy', kind: 'skill', source: 'user', description: 'Deploy to staging with checks' },
      { name: 'front:component', kind: 'command', source: 'project', description: 'Make component' },
      { name: 'review', kind: 'skill', source: 'project', description: 'Review the current change' }
    ])
    expect(listed.every((item) => path.isAbsolute(item.path))).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('PRIVATE')
    expect(resolveClaudeWorkflowPrompt('$front:component  Button.tsx\nkeep props', listed)?.prompt)
      .toBe('/front:component  Button.tsx\nkeep props')
    expect(resolveClaudeWorkflowPrompt('/DEPLOY staging', listed)?.prompt).toBe('/deploy staging')
    expect(resolveClaudeWorkflowPrompt('/unknown task', listed)).toBeNull()
    expect(resolveClaudeWorkflowPrompt('Explain $deploy', listed)).toBeNull()
  })

  it('uses only safe local names, frontmatter and exact skill manifests', async () => {
    await write('workspace/.claude/commands/simple.md', 'No frontmatter\nPRIVATE BODY')
    await write('workspace/.claude/commands/dot.name.md', '---\ndescription: Invalid name\n---')
    await write('user-claude/skills/bad/SKILL.md', '---\nname: ../escape\ndescription: Invalid\n---')
    await write('user-claude/skills/empty/NOT-SKILL.md', '---\ndescription: Not a skill\n---')

    const listed = await listClaudeWorkflows({ projectRoot: workspace, userConfigRoot: userConfig })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'simple', description: '', kind: 'command', source: 'project' })
    expect(JSON.stringify(listed)).not.toContain('PRIVATE')
    expect(resolveClaudeWorkflowPrompt('$simple', listed)?.prompt).toBe('/simple')
    expect(resolveClaudeWorkflowPrompt('/simple/../../other', listed)).toBeNull()
  })

  it('returns an empty list when neither scope exists', async () => {
    expect(await listClaudeWorkflows({ projectRoot: workspace, userConfigRoot: userConfig })).toEqual([])
  })
})
