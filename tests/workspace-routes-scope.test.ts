import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchRequest, Launcher } from '../server/threads/manager.ts'
import { startServer, type RunningServer } from '../server/start.ts'

// Order 17c (W12-08), desktop routes: Files, Git, process lists and @file attachments take an explicit
// workspaceId and work in that workspace's folder. A gone, foreign or disagreeing workspace is refused;
// nothing falls back to the primary. A legacy projectPath still means the primary.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

function repoIn(dir: string, name: string): string {
  const repo = join(dir, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# garden\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

describe('desktop routes resolve against the explicit workspace', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('files, git, processes and @file all use the worktree; legacy paths and gone workspaces behave', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-scope-')))
    const repo = repoIn(dir, 'garden')
    const other = repoIn(dir, 'orchard')
    const launches: LaunchRequest[] = []
    const sent: string[] = []
    const emits: Array<(event: { kind: 'result'; ok: boolean }) => void> = []
    const launcher: Launcher = (request, emit) => {
      launches.push(request)
      emits.push(emit as never)
      return { agent: 'claude', alive: () => true, send: (text) => { sent.push(text) }, respondApproval() {}, interrupt() {}, close: async () => { emit({ kind: 'exit', code: 0 }) } }
    }
    const state = join(dir, 'state')
    running = await startServer({ port: 0, webDist: dir, stateRoot: state, launchers: { claude: launcher, codex: launcher } })
    const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}/api${path}`, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      return { status: res.status, body: await res.json() }
    }
    const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`

    await call('/projects', { path: repo, pinned: true })
    await call('/projects', { path: other, pinned: true })
    const projects = (await call('/projects')).body.data as Array<{ path: string; projectId: string; workspaceId: string }>
    const garden = projects.find((p) => p.path === repo)!
    const orchard = projects.find((p) => p.path === other)!
    const spike = (await call(`/projects/${garden.projectId}/workspaces`, { name: 'Spike' })).body.data.workspace as { id: string; cwd: string }
    const foreign = (await call(`/projects/${orchard.projectId}/workspaces`, { name: 'Elsewhere' })).body.data.workspace as { id: string; cwd: string }

    // The two checkouts now differ: one file only in the primary, one only in the worktree, a branch each.
    writeFileSync(join(repo, 'only-primary.md'), 'primary only\n')
    writeFileSync(join(spike.cwd, 'only-spike.md'), 'spike only\n')

    // Files: list, read, search resolve inside the chosen workspace.
    const names = async (params: Record<string, string>) => ((await call(`/files${q(params)}`)).body.data.entries as Array<{ name: string }>).map((e) => e.name)
    expect(await names({ workspaceId: spike.id })).toContain('only-spike.md')
    expect(await names({ workspaceId: spike.id })).not.toContain('only-primary.md')
    expect(await names({ projectPath: repo })).toContain('only-primary.md')
    expect(await names({ workspaceId: garden.workspaceId })).toContain('only-primary.md')
    expect(await names({ workspaceId: garden.workspaceId, projectPath: repo })).toContain('only-primary.md')
    // A pin is a path inside the workspace: present in the primary, reported missing in the worktree, never looked up in the primary.
    await call('/projects/pins', { path: repo, files: ['only-primary.md'] })
    expect((await call(`/files/read${q({ projectPath: repo, path: 'only-primary.md' })}`)).status).toBe(200)
    const missing = await call(`/files/read${q({ workspaceId: spike.id, path: 'only-primary.md' })}`)
    expect(missing).toMatchObject({ status: 400, body: { error: 'Not found in this project: only-primary.md' } })
    expect((await call(`/files/read${q({ workspaceId: spike.id, path: 'only-spike.md' })}`)).body.data.text).toBe('spike only\n')
    expect((await call(`/files/search${q({ workspaceId: spike.id, q: 'only' })}`)).body.data.matches.map((m: { path: string }) => m.path)).toEqual(['only-spike.md'])

    // Write and rename land in the worktree's folder.
    const written = await call('/files/write', { workspaceId: spike.id, path: 'new.txt', text: 'hello\n', expected: null, space: 'project' }, 'PUT')
    expect(written.status).toBe(200)
    expect(readFileSync(join(spike.cwd, 'new.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect((await call('/files/rename', { workspaceId: spike.id, path: 'new.txt', name: 'renamed.txt', space: 'project' })).body.data.path).toBe('renamed.txt')
    expect(existsSync(join(spike.cwd, 'renamed.txt'))).toBe(true)

    // Git: state, changes and branch changes belong to the workspace; the primary does not move.
    expect((await call(`/git${q({ workspaceId: spike.id })}`)).body.data).toMatchObject({ branch: 'codex/spike' })
    expect((await call(`/git${q({ projectPath: repo })}`)).body.data).toMatchObject({ branch: 'main' })
    const changed = ((await call(`/git/changes${q({ workspaceId: spike.id })}`)).body.data.files as Array<{ path: string }>).map((f) => f.path)
    expect(changed).toContain('only-spike.md')
    expect(changed).not.toContain('only-primary.md')
    expect((await call('/git/create', { workspaceId: spike.id, branch: 'codex/spike-two' })).body.data).toMatchObject({ branch: 'codex/spike-two' })
    expect(git(spike.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('codex/spike-two')
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')

    // Process lists: one workspace's, or the project's as before.
    const dev = (cwd: string, workspaceId?: string) => running!.processes.start({ projectPath: repo, cwd, ...(workspaceId ? { workspaceId } : {}), command: 'sleep 30', name: 'dev' })
    const inSpike = dev(spike.cwd, spike.id).process
    const inMain = dev(repo, garden.workspaceId).process
    const ids = async (params: Record<string, string>) => ((await call(`/processes${q(params)}`)).body.data as Array<{ id: string }>).map((p) => p.id)
    expect(await ids({ workspaceId: spike.id })).toEqual([inSpike.id])
    expect(await ids({ workspaceId: garden.workspaceId })).toEqual([inMain.id])
    expect((await ids({ project: repo })).sort()).toEqual([inSpike.id, inMain.id].sort())

    // @file attachments: a new conversation in the worktree reads the worktree; a message names its workspace or follows the conversation's.
    const created = await call('/threads', { projectPath: repo, workspaceId: spike.id, text: 'Read @file:only-spike.md' })
    expect(created.status).toBe(201)
    expect(created.body.data.workspaceId).toBe(spike.id)
    expect(sent[0]).toContain('spike only')
    expect(launches[0]!.cwd).toBe(spike.cwd)
    const threadId = created.body.data.id as string
    expect((await call(`/threads/${threadId}/messages`, { text: 'Again @file:only-spike.md' })).status).toBe(202)
    expect(sent[1]).toContain('spike only')
    // The primary's file is not found from the conversation working in the worktree.
    const wrong = await call(`/threads/${threadId}/messages`, { text: 'And @file:only-primary.md' })
    expect(wrong).toMatchObject({ status: 400, body: { error: 'Not found in this project: only-primary.md' } })
    expect(sent).toHaveLength(2)
    // References are checked in the workspace too.
    const checks = (await call('/references/check', { workspaceId: spike.id, text: '@file:only-primary.md @file:only-spike.md' })).body.data as Array<{ reference: string; ok: boolean }>
    expect(checks.map((c) => [c.reference, c.ok])).toEqual([['only-primary.md', false], ['only-spike.md', true]])

    // A conversation working in the worktree blocks branch changes there, not in the primary.
    expect(running.manager.status(threadId)).not.toBe('idle')
    expect((await call('/git/create', { workspaceId: spike.id, branch: 'codex/blocked' })).status).toBe(409)
    expect((await call('/git/create', { workspaceId: garden.workspaceId, branch: 'free-in-main' })).status).toBe(200)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('free-in-main')
    expect(git(spike.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('codex/spike-two')

    // Refusals: unknown, disagreeing, another project's closed workspace, and a removed one.
    expect((await call(`/files${q({ workspaceId: '00000000-0000-4000-8000-000000000000' })}`)).status).toBe(409)
    expect((await call(`/files${q({ workspaceId: spike.id, projectPath: other })}`)).status).toBe(409)
    expect((await call(`/files${q({})}`)).status).toBe(400)
    expect((await call(`/git${q({ workspaceId: foreign.id })}`)).status).toBe(200)
    await call('/projects/remove', { path: other })
    expect((await call(`/files${q({ workspaceId: foreign.id })}`)).status).toBe(404)
    expect((await call(`/git${q({ workspaceId: foreign.id })}`)).status).toBe(404)

    const file = join(state, 'workspaces.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const w of data.workspaces) if (w.id === spike.id) w.lifecycle = 'removed'
    writeFileSync(file, JSON.stringify(data))
    for (const path of [`/files${q({ workspaceId: spike.id })}`, `/git${q({ workspaceId: spike.id })}`, `/git/changes${q({ workspaceId: spike.id })}`, `/processes${q({ workspaceId: spike.id })}`]) {
      const refused = await call(path)
      expect(refused.status, path).toBe(409)
      expect(refused.body.error).not.toContain(repo)
    }
    // The conversation that lived there is not silently moved to the primary: its message is refused.
    const stuck = await call(`/threads/${threadId}/messages`, { text: 'still there? @file:README.md' })
    expect(stuck.status).toBe(409)
    expect(sent).toHaveLength(2)
    // The person can continue it in the primary by saying so, once it is idle.
    for (let i = 0; i < 6 && running.manager.status(threadId) !== 'idle'; i++) { emits.at(-1)!({ kind: 'result', ok: true }); await new Promise((r) => setTimeout(r, 20)) }
    expect((await call(`/threads/${threadId}/messages`, { text: 'back home @file:README.md', workspaceId: garden.workspaceId })).status).toBe(202)
    expect(sent.at(-1)).toContain('# garden')
  })
})
