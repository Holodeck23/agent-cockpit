import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'
import { materializeSkillProjection, PROJECTION_PLUGIN, snapshotSkillSource } from '../server/agents/setup/skill-projection.ts'
import { createSkillProvider, createSkillSelectionStore } from '../server/agents/setup/skill-selection.ts'
import type { AgentSession } from '../server/agents/types.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { LaunchRequest, Launcher } from '../server/threads/manager.ts'

// W13 U6: the user's own skills, commands and agents reach a Claude session as a private plugin
// projection of one reviewed revision. Links are not copied, the source is never passed, and any
// change asks for a fresh review.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-skill-projection-')))
  const profile = join(root, 'default-claude')
  const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  write(join(profile, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nW13 fictional deploy skill')
  write(join(profile, 'skills', 'deploy', 'scripts', 'run.sh'), '#!/bin/sh\necho never run by Cockpit\n')
  write(join(profile, 'commands', 'git', 'commit.md'), 'legacy command')
  write(join(profile, 'agents', 'reviewer.md'), 'agent')
  const elsewhere = join(root, 'elsewhere')
  write(join(elsewhere, 'SKILL.md'), 'linked skill')
  symlinkSync(elsewhere, join(profile, 'skills', 'linked'))
  return { root, profile, write, elsewhere }
}

describe('skill projection (W13 U6)', () => {
  it('snapshots skills, commands and agents, and excludes a linked skill instead of copying through it', () => {
    const f = fixture()
    const snap = snapshotSkillSource(f.profile)
    expect(snap).toMatchObject({ skills: ['deploy'], commands: ['git:commit'], agents: ['reviewer'] })
    expect(snap.excluded).toEqual([{ path: join('skills', 'linked'), reason: 'linked', target: f.elsewhere, includable: true }])
    expect(snap.included).toEqual([])
    f.write(join(f.profile, 'skills', 'deploy', 'SKILL.md'), 'edited')
    expect(snapshotSkillSource(f.profile).revision).not.toBe(snap.revision)
  })

  it('copies an included link only while it points at the reviewed target, and binds both to the revision', () => {
    const f = fixture()
    const plain = snapshotSkillSource(f.profile)
    const link = { path: join('skills', 'linked'), target: f.elsewhere }
    const snap = snapshotSkillSource(f.profile, { links: [link] })
    expect(snap.skills).toEqual(['deploy', 'linked'])
    expect(snap.included).toEqual([link])
    expect(snap.excluded).toEqual([])
    expect(snap.revision).not.toBe(plain.revision)
    const dir = materializeSkillProjection(snap, join(f.root, 'projections'))
    expect(readFileSync(join(dir, 'skills', 'linked', 'SKILL.md'), 'utf8')).toBe('linked skill')
    expect(lstatSync(join(dir, 'skills', 'linked')).isSymbolicLink()).toBe(false)
    // Edited where it points: a new revision.
    f.write(join(f.elsewhere, 'SKILL.md'), 'edited elsewhere')
    expect(snapshotSkillSource(f.profile, { links: [link] }).revision).not.toBe(snap.revision)
    // Pointed somewhere else: not followed, and reported again as a link to review.
    const other = join(f.root, 'other')
    f.write(join(other, 'SKILL.md'), 'not reviewed')
    unlinkSync(join(f.profile, 'skills', 'linked'))
    symlinkSync(other, join(f.profile, 'skills', 'linked'))
    const moved = snapshotSkillSource(f.profile, { links: [link] })
    expect(moved.included).toEqual([])
    expect(moved.skills).toEqual(['deploy'])
    expect(moved.excluded).toEqual([{ path: join('skills', 'linked'), reason: 'linked', target: other, includable: true }])
  })

  it('never follows a link inside an included target, and cannot include a nested or broken link', () => {
    const f = fixture()
    f.write(join(f.root, 'secret', 'notes.md'), 'outside the review')
    symlinkSync(join(f.root, 'secret'), join(f.elsewhere, 'more'))
    symlinkSync(join(f.root, 'missing'), join(f.profile, 'skills', 'broken'))
    symlinkSync(join(f.root, 'secret'), join(f.profile, 'skills', 'deploy', 'vendor'))
    const snap = snapshotSkillSource(f.profile, { links: [{ path: join('skills', 'linked'), target: f.elsewhere }] })
    expect(snap.files.map((file) => file.relativePath)).not.toContain(join('skills', 'linked', 'more', 'notes.md'))
    expect(snap.excluded).toEqual([
      { path: join('skills', 'broken'), reason: 'linked' },
      { path: join('skills', 'deploy', 'vendor'), reason: 'linked', target: join(f.root, 'secret') },
      { path: join('skills', 'linked', 'more'), reason: 'linked', target: join(f.root, 'secret') },
    ])
  })

  it('builds one private plugin folder per revision, reuses it, and leaves the source untouched', () => {
    const f = fixture()
    const snap = snapshotSkillSource(f.profile)
    const dir = materializeSkillProjection(snap, join(f.root, 'projections'))
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe(PROJECTION_PLUGIN)
    expect(readFileSync(join(dir, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('W13 fictional deploy skill')
    expect(readFileSync(join(dir, 'agents', 'reviewer.md'), 'utf8')).toBe('agent')
    expect(() => lstatSync(join(dir, 'skills', 'linked'))).toThrow()
    expect(lstatSync(join(f.root, 'projections')).mode & 0o077).toBe(0)
    expect(materializeSkillProjection(snap, join(f.root, 'projections'))).toBe(dir)
    expect(readFileSync(join(f.profile, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('W13 fictional deploy skill')
  })

  it('loads only for the chosen account and stops on a changed source, another generation or a revoked choice', () => {
    const f = fixture()
    const selections = createSkillSelectionStore(join(f.root, 'state'))
    const provider = createSkillProvider({ selections, projectionRoot: join(f.root, 'projections') })
    const project = join(f.root, 'project')
    const chosen = selections.select({ projectPath: project, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'default-claude', sourceProfileDir: f.profile })
    expect(chosen.counts).toEqual({ skills: 1, commands: 1, agents: 1, excluded: 1 })
    const launched = provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })!
    expect(readFileSync(join(launched.pluginDirs[0]!, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('W13 fictional')
    expect(provider({ projectPath: project, accountId: 'acct-b', accountGeneration: 1 })).toBeUndefined()
    expect(() => provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 2 })).toThrow('different account generation')
    f.write(join(f.profile, 'agents', 'reviewer.md'), 'edited agent')
    expect(() => launched.validate()).toThrow(/changed since they were chosen/)
    expect(() => provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })).toThrow(/changed since they were chosen/)
    const again = selections.select({ projectPath: project, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'default-claude', sourceProfileDir: f.profile }, chosen.id)
    expect(again.includedLinks).toEqual([])
    const relaunched = provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })!
    selections.revoke(project, again.id)
    expect(() => relaunched.validate()).toThrow('Skill selection changed')
  })

  it('includes a reviewed link at its current target, and stops when that target changes', () => {
    const f = fixture()
    const selections = createSkillSelectionStore(join(f.root, 'state'))
    const provider = createSkillProvider({ selections, projectionRoot: join(f.root, 'projections') })
    const project = join(f.root, 'project')
    const input = { projectPath: project, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'default-claude', sourceProfileDir: f.profile }
    expect(() => selections.select({ ...input, includeLinks: [join('skills', 'deploy')] })).toThrow('is not a link that can be included')
    const chosen = selections.select({ ...input, includeLinks: [join('skills', 'linked')] })
    expect(chosen.includedLinks).toEqual([{ path: join('skills', 'linked'), target: f.elsewhere }])
    expect(chosen.counts).toEqual({ skills: 2, commands: 1, agents: 1, excluded: 0 })
    const launched = provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })!
    expect(readFileSync(join(launched.pluginDirs[0]!, 'skills', 'linked', 'SKILL.md'), 'utf8')).toBe('linked skill')
    expect(() => launched.validate()).not.toThrow()
    f.write(join(f.elsewhere, 'SKILL.md'), 'edited elsewhere')
    expect(() => launched.validate()).toThrow(/changed since they were chosen/)
    rmSync(f.elsewhere, { recursive: true })
    expect(() => provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })).toThrow(/changed since they were chosen/)
  })

  it('passes each projection as --plugin-dir, and only absolute host folders', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', pluginDirs: ['/private/projection'] })
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/private/projection')
    expect(() => buildClaudeArgs({ cwd: '/tmp', pluginDirs: ['relative/dir'] })).toThrow()
    expect(buildClaudeArgs({ cwd: '/tmp' })).not.toContain('--plugin-dir')
  })
})

describe('skill routes (W13 U6)', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('chooses the default profile skills and the next Claude conversation loads their projection', async () => {
    const f = fixture()
    const project = join(f.root, 'project')
    mkdirSync(project)
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
    await call('/api/projects', { path: project, pinned: true })
    const projectId = (await call('/api/projects')).body.data.find((p: { path: string }) => p.path === project).projectId as string
    const offered = await call(`/api/projects/${projectId}/skills`)
    expect(offered.body.data).toMatchObject({ selection: null, offered: { skills: ['deploy'], commands: ['git:commit'], agents: ['reviewer'] } })
    // No folder but where the link points.
    expect(JSON.stringify(offered.body).replaceAll(f.elsewhere, '')).not.toContain(f.root)
    expect(offered.body.data.offered.excluded).toEqual([{ path: join('skills', 'linked'), reason: 'linked', target: f.elsewhere, includable: true }])
    expect(offered.body.data.offered.plugins).toEqual([])
    const chosen = await call(`/api/projects/${projectId}/skills`, { sourceAccountId: 'default-claude' })
    expect(chosen.status).toBe(200)
    expect((await call(`/api/projects/${projectId}/skills`, { sourceAccountId: 'someone-else' })).status).toBe(400)
    await call('/api/threads', { projectPath: project, text: 'hello', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    const dir = launches.at(-1)?.pluginDirs?.[0]
    expect(dir && readFileSync(join(dir, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('W13 fictional deploy skill')
    const withLink = await call(`/api/projects/${projectId}/skills`, { sourceAccountId: 'default-claude', replacing: chosen.body.data.selection.id, includeLinks: [join('skills', 'linked')] })
    expect(withLink.body.data.selection.includedLinks).toEqual([{ path: join('skills', 'linked'), target: f.elsewhere }])
    expect((await call(`/api/projects/${projectId}/skills`)).body.data.selection.current).toBe(true)
    await call('/api/threads', { projectPath: project, text: 'with the link', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    const linkedDir = launches.at(-1)?.pluginDirs?.[0]
    expect(linkedDir && readFileSync(join(linkedDir, 'skills', 'linked', 'SKILL.md'), 'utf8')).toBe('linked skill')
    f.write(join(f.elsewhere, 'SKILL.md'), 'edited elsewhere')
    expect((await call(`/api/projects/${projectId}/skills`)).body.data.selection.current).toBe(false)
    await call(`/api/projects/${projectId}/skills/revoke`, { selectionId: withLink.body.data.selection.id })
    await call('/api/threads', { projectPath: project, text: 'after revoke', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    expect(launches.at(-1)?.pluginDirs).toBeUndefined()
  })
})
