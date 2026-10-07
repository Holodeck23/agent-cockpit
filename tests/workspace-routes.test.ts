import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isRemoteRoute } from '../server/remote/guard.ts'
import { startServer, type RunningServer } from '../server/start.ts'

// Order 17a routes end to end (INTERFACES /api/projects/:id/workspaces): the Mac lists a project's
// workspaces, sees what a new worktree leaves behind, creates one and reads a refusal it can act on.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }

describe('workspace routes', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('lists, previews and creates a worktree; refusals say what to do', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-workspace-routes-')))
    const repo = join(dir, 'garden')
    mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env })
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['-C', repo, 'add', '.'], { env })
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'first'], { env })
    writeFileSync(join(repo, 'dirty.txt'), 'not committed\n')

    running = await startServer({ port: 0, webDist: dir, stateRoot: join(dir, 'state') })
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    await call('/api/projects', { path: repo, pinned: true })
    const projectId = (await call('/api/projects')).body.data.find((p: { path: string }) => p.path === repo).projectId as string

    const listed = await call(`/api/projects/${projectId}/workspaces`)
    expect(listed.status).toBe(200)
    expect(listed.body.data.workspaces.map((w: { kind: string }) => w.kind)).toEqual(['primary'])
    expect(listed.body.data.pending).toEqual([])

    const preflight = await call(`/api/projects/${projectId}/workspaces/preflight`)
    expect(preflight.body.data).toMatchObject({ branch: 'main', uncommitted: 1, branchPrefix: 'codex/' })

    const created = await call(`/api/projects/${projectId}/workspaces`, { name: 'Spike' })
    expect(created.status).toBe(201)
    expect(created.body.data.workspace).toMatchObject({ kind: 'worktree', name: 'Spike', branch: 'codex/spike' })
    expect((await call(`/api/projects/${projectId}/workspaces`)).body.data.workspaces).toHaveLength(2)

    const refused = await call(`/api/projects/${projectId}/workspaces`, { name: 'Other', branch: 'main' })
    expect(refused.status).toBe(409)
    expect(refused.body.refusal).toMatchObject({ code: 'branch-exists', branch: 'main' })
    expect(refused.body.error).toContain('Choose another branch name')

    expect((await call('/api/projects/00000000-0000-4000-8000-000000000000/workspaces')).status).toBe(404)
    expect((await call('/api/workspace-operations/nope/recover', {})).status).toBe(404)
    expect((await call(`/api/projects/${projectId}/workspaces`, { name: 1 })).status).toBe(400)

    // Order 18a: Git's view, then remove what is clean and archive what is not (W12-12, W12-13, W12-14).
    const spike = created.body.data.workspace as { id: string; cwd: string }
    expect((await call(`/api/projects/${projectId}/workspaces`)).body.data.health).toEqual({ [spike.id]: { state: 'ok' } })
    writeFileSync(join(spike.cwd, 'notes.txt'), 'only here\n')
    const unique = await call(`/api/workspaces/${spike.id}/removal`)
    expect(unique.body.data).toMatchObject({ removable: false, unique: { untracked: 1 } })
    const kept = await call(`/api/workspaces/${spike.id}/remove`, { fingerprint: unique.body.data.fingerprint })
    expect(kept.status).toBe(409)
    expect(kept.body.error).toBe('Removing it would lose 1 untracked file. Keep it, or archive it as it is.')
    expect((await call(`/api/workspaces/${spike.id}/archive`, {})).body.data.workspace).toMatchObject({ lifecycle: 'archived' })
    expect((await call(`/api/workspaces/${spike.id}/restore`, {})).body.data.workspace).toMatchObject({ lifecycle: 'active' })

    const clean = (await call(`/api/projects/${projectId}/workspaces`, { name: 'Clean' })).body.data.workspace as { id: string; cwd: string }
    const check = (await call(`/api/workspaces/${clean.id}/removal`)).body.data
    expect(check.removable).toBe(true)
    expect((await call(`/api/workspaces/${clean.id}/remove`, { fingerprint: 'not-the-one-checked' })).body.refusal).toMatchObject({ code: 'stale' })
    expect((await call(`/api/workspaces/${clean.id}/remove`, { fingerprint: check.fingerprint })).body.data.workspace).toMatchObject({ lifecycle: 'removed' })

    const primaryId = (await call(`/api/projects/${projectId}/workspaces`)).body.data.workspaces[0].id as string
    const primaryRefused = await call(`/api/workspaces/${primaryId}/archive`, {})
    expect(primaryRefused.status).toBe(409)
    expect(primaryRefused.body.error).toBe('The main checkout cannot be removed or archived.')
    expect((await call('/api/workspaces/00000000-0000-4000-8000-000000000000/removal')).status).toBe(404)
  })

  it('keeps every workspace route off the phone', () => {
    for (const [method, path] of [['GET', '/api/projects/p/workspaces'], ['GET', '/api/projects/p/workspaces/preflight'], ['POST', '/api/projects/p/workspaces'],
      ['POST', '/api/workspace-operations/o/recover'], ['POST', '/api/workspace-operations/o/dismiss'],
      ['GET', '/api/workspaces/w/removal'], ['POST', '/api/workspaces/w/remove'], ['POST', '/api/workspaces/w/archive'],
      ['POST', '/api/workspaces/w/restore'], ['POST', '/api/workspaces/w/forget']] as const) {
      expect(isRemoteRoute(method, path)).toBe(false)
    }
  })
})
