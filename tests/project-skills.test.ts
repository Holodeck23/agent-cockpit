import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_PLUGIN } from '../server/agents/setup/skill-projection.ts'
import { combineSkillProviders, createSkillProvider, createSkillSelectionStore, type SkillProvider } from '../server/agents/setup/skill-selection.ts'
import type { AgentSession } from '../server/agents/types.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { LaunchRequest, Launcher } from '../server/threads/manager.ts'
import { SkillChoice } from '../web/src/components/ProjectClaudeSetup.tsx'

// W13 U6: a project's own skills (its .claude folder) do not load under strict setting sources, so they
// are reviewed and projected like the user's. They are the repository's, for any account, read from the
// main checkout, and load after the user's own so a same-name user skill wins, as in the plain CLI.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-project-skills-')))
  const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  const project = join(root, 'project'), profile = join(root, 'default-claude')
  write(join(project, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\n---\nW13 fictional project skill')
  write(join(project, '.claude', 'commands', 'triage.md'), 'project command')
  write(join(project, '.claude', 'settings.json'), '{"hooks":{}}')
  write(join(profile, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nW13 fictional user skill')
  return { root, project, profile, write }
}

describe('project skills (W13 U6)', () => {
  it('load for any account, only in the main checkout, and stop when the project changes them', () => {
    const f = fixture()
    const selections = createSkillSelectionStore(join(f.root, 'state'))
    const provider = createSkillProvider({ selections, projectionRoot: join(f.root, 'projections'), projectSkills: true,
      identity: { name: PROJECT_PLUGIN, description: 'project' } })
    const chosen = selections.select({ projectPath: f.project, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'project',
      sourceProfileDir: join(f.project, '.claude') })
    expect(chosen.counts).toEqual({ skills: 1, commands: 1, agents: 0, excluded: 0 })
    const launched = provider({ projectPath: f.project, accountId: 'acct-b', accountGeneration: 7, cwd: f.project })!
    expect(JSON.parse(readFileSync(join(launched.pluginDirs[0]!, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('project')
    expect(readFileSync(join(launched.pluginDirs[0]!, 'skills', 'release', 'SKILL.md'), 'utf8')).toContain('W13 fictional project skill')
    // Only skills, commands and agents: the project's settings (and so its hooks) are not part of it.
    expect(() => readFileSync(join(launched.pluginDirs[0]!, 'settings.json'))).toThrow()
    expect(provider({ projectPath: f.project, accountId: 'acct-a', accountGeneration: 1, cwd: join(f.root, 'worktree') })).toBeUndefined()
    f.write(join(f.project, '.claude', 'commands', 'triage.md'), 'edited on a branch')
    expect(() => launched.validate()).toThrow("This project's skills, commands or agents changed since they were chosen")
  })

  it('pass the user\'s folder first, then the project\'s, then plugins, so a bare name resolves as in the CLI', () => {
    const own: SkillProvider = () => ({ pluginDirs: ['/p/my-setup', '/p/my-setup/.cockpit-plugins/vercel'], selectionId: 'own', validate: () => undefined })
    let checked = false
    const project: SkillProvider = () => ({ pluginDirs: ['/p/project'], selectionId: 'project', validate: () => { checked = true } })
    const none: SkillProvider = () => undefined
    const both = combineSkillProviders(own, project)({ projectPath: '/p', accountId: 'a', accountGeneration: 1 })!
    expect(both.pluginDirs).toEqual(['/p/my-setup', '/p/project', '/p/my-setup/.cockpit-plugins/vercel'])
    both.validate()
    expect(checked).toBe(true)
    expect(combineSkillProviders(none, project)({ projectPath: '/p', accountId: 'a', accountGeneration: 1 })?.selectionId).toBe('project')
    expect(combineSkillProviders(own, none)({ projectPath: '/p', accountId: 'a', accountGeneration: 1 })?.selectionId).toBe('own')
  })

  it('the wording says whose skills they are, and offers nothing to choose for a project without any', () => {
    const empty = renderToStaticMarkup(createElement(SkillChoice, { kind: 'project', view: { selection: null,
      offered: { sourceAccountId: 'project', skills: [], commands: [], agents: [], excluded: [], plugins: [] } }, onChoose: () => undefined, onRevoke: () => undefined }))
    expect(empty).toContain("This project&#x27;s Claude skills")
    expect(empty).toContain('Not yet in worktree conversations.')
    expect(empty).toContain("Not loading this project&#x27;s skills.")
    expect(empty).not.toContain('<button')
    const some = renderToStaticMarkup(createElement(SkillChoice, { kind: 'project', view: { selection: null,
      offered: { sourceAccountId: 'project', skills: ['release'], commands: [], agents: [], excluded: [], plugins: [] } }, onChoose: () => undefined, onRevoke: () => undefined }))
    expect(some).toContain("Use this project&#x27;s skills</button>")
  })
})

describe('project skill routes (W13 U6)', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('chooses the project\'s skills and the next conversation loads them after the user\'s own', async () => {
    const f = fixture()
    const launches: LaunchRequest[] = []
    const launcher: Launcher = (request, onEvent) => {
      launches.push(request)
      let alive = true
      const session: AgentSession = { agent: 'claude', send: () => onEvent({ kind: 'result', ok: true }), respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => alive }
      return session
    }
    running = await startServer({ port: 0, webDist: f.root, stateRoot: join(f.root, 'state'), claudeDefaultProfileDir: f.profile, launchers: { claude: launcher } })
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    await call('/api/projects', { path: f.project, pinned: true })
    const projectId = (await call('/api/projects')).body.data.find((p: { path: string }) => p.path === f.project).projectId as string
    const offered = await call(`/api/projects/${projectId}/project-skills`)
    expect(offered.body.data).toMatchObject({ selection: null, offered: { sourceAccountId: 'project', skills: ['release'], commands: ['triage'], plugins: [] } })
    expect(JSON.stringify(offered.body)).not.toContain(f.root)
    expect((await call(`/api/projects/${projectId}/project-skills`, { sourceAccountId: 'default-claude' })).status).toBe(400)
    expect((await call(`/api/projects/${projectId}/project-skills`, { sourceAccountId: 'project', includePlugins: ['x@y'] })).status).toBe(409)
    const project = await call(`/api/projects/${projectId}/project-skills`, { sourceAccountId: 'project' })
    expect(project.status).toBe(200)
    const own = await call(`/api/projects/${projectId}/skills`, { sourceAccountId: 'default-claude' })
    expect(own.status).toBe(200)
    await call('/api/threads', { projectPath: f.project, text: 'hello', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    const dirs = launches.at(-1)?.pluginDirs ?? []
    expect(dirs).toHaveLength(2)
    expect(readFileSync(join(dirs[0]!, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('W13 fictional user skill')
    expect(readFileSync(join(dirs[1]!, 'skills', 'release', 'SKILL.md'), 'utf8')).toContain('W13 fictional project skill')
    expect((await call(`/api/projects/${projectId}/project-skills`)).body.data.selection).toMatchObject({ sourceAccountId: 'project', current: true })
    await call(`/api/projects/${projectId}/project-skills/revoke`, { selectionId: project.body.data.selection.id })
    await call('/api/threads', { projectPath: f.project, text: 'after revoke', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    expect(launches.at(-1)?.pluginDirs).toHaveLength(1)
  })
})
