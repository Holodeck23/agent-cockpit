import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StoreReadError } from '../server/state/read-error.ts'
import { WORKSPACES_SCHEMA_VERSION, createWorkspaceStore, gitCommonDir } from '../server/projects/workspaces.ts'

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-workspaces-'))
const folder = (name: string): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cockpit-ws-folder-')), name)
  mkdirSync(dir)
  return dir
}

describe('workspace identity (ID-01, ID-02, ID-08)', () => {
  it('gives each project folder one project and one primary workspace, stable across reopen', () => {
    const root = newRoot()
    const site = folder('site')
    const first = createWorkspaceStore(root)
    first.ensure([site])
    const a = first.primaryFor(site)!
    expect(a.workspace).toMatchObject({ projectId: a.project.id, kind: 'primary', cwd: site, canonicalCwd: realpathSync(site), managed: false, lifecycle: 'active' })
    const reopened = createWorkspaceStore(root)
    reopened.ensure([site])
    expect(reopened.primaryFor(site)).toEqual(a)
    expect(reopened.get(a.workspace.id)).toEqual(a.workspace)
  })

  it('migrating twice is a no-op: same IDs, same bytes, same revision', () => {
    const root = newRoot()
    const paths = [folder('a'), folder('b')]
    createWorkspaceStore(root).ensure(paths)
    const bytes = readFileSync(join(root, 'workspaces.json'), 'utf8')
    createWorkspaceStore(root).ensure(paths)
    expect(readFileSync(join(root, 'workspaces.json'), 'utf8')).toBe(bytes)
  })

  it('a migration interrupted before its rename leaves the old file and resumes cleanly', () => {
    const root = newRoot()
    const a = folder('a')
    const store = createWorkspaceStore(root)
    store.ensure([a])
    const before = store.primaryFor(a)
    // A crash between writing the temp file and renaming it.
    writeFileSync(join(root, 'workspaces.json.tmp'), '{"schemaVersion":1,"revis')
    const b = folder('b')
    const restarted = createWorkspaceStore(root)
    expect(restarted.primaryFor(a)).toEqual(before)
    restarted.ensure([a, b])
    expect(restarted.primaryFor(a)).toEqual(before)
    expect(restarted.primaryFor(b)).toBeDefined()
  })

  it('two folders with the same name stay separate; one folder reached by a symlink is the same', () => {
    const root = newRoot()
    const one = folder('app')
    const two = folder('app')
    const link = join(mkdtempSync(join(tmpdir(), 'cockpit-ws-link-')), 'app-link')
    symlinkSync(one, link)
    const store = createWorkspaceStore(root)
    store.ensure([one, two, link])
    expect(store.primaryFor(one)!.project.id).not.toBe(store.primaryFor(two)!.project.id)
    expect(store.primaryFor(link)).toEqual(store.primaryFor(one))
    expect(store.list().projects).toHaveLength(2)
  })

  it('ignores relative paths and answers undefined for folders it has not seen', () => {
    const store = createWorkspaceStore(newRoot())
    store.ensure(['relative/path'])
    expect(store.list().projects).toEqual([])
    expect(store.primaryFor(folder('unseen'))).toBeUndefined()
  })

  it('a malformed file fails visibly and is never overwritten', () => {
    const root = newRoot()
    const bad = '{"schemaVersion":1,"projects":[{"id":'
    writeFileSync(join(root, 'workspaces.json'), bad)
    const store = createWorkspaceStore(root)
    expect(() => store.list()).toThrow(StoreReadError)
    expect(() => store.ensure([folder('a')])).toThrow(/preserved/)
    expect(readFileSync(join(root, 'workspaces.json'), 'utf8')).toBe(bad)
  })

  it('a file from a newer Cockpit is refused and left untouched', () => {
    const root = newRoot()
    const future = JSON.stringify({ schemaVersion: WORKSPACES_SCHEMA_VERSION + 1, revision: 9, projects: [], workspaces: [], somethingNew: true })
    writeFileSync(join(root, 'workspaces.json'), future)
    const store = createWorkspaceStore(root)
    expect(() => store.ensure([folder('a')])).toThrow(expect.objectContaining({ code: 'FUTURE_VERSION' }))
    expect(readFileSync(join(root, 'workspaces.json'), 'utf8')).toBe(future)
  })
})

describe('git identity of a workspace', () => {
  it('is the .git folder for a repository, also from a subfolder', () => {
    const repo = folder('repo')
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'web'))
    expect(gitCommonDir(repo)).toBe(realpathSync(join(repo, '.git')))
    expect(gitCommonDir(join(repo, 'web'))).toBe(realpathSync(join(repo, '.git')))
  })

  it('is the main repository for a linked worktree', () => {
    const main = folder('main')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n')
    const tree = folder('feature')
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
    expect(gitCommonDir(tree)).toBe(realpathSync(join(main, '.git')))
  })

  it('is null outside Git', () => {
    expect(gitCommonDir(folder('plain'))).toBeNull()
  })
})

describe('identity over HTTP', () => {
  it('lists projects with stable opaque IDs; a damaged projects.json is a visible 409 while conversations still list', async () => {
    const { startServer } = await import('../server/start.ts')
    const stateRoot = newRoot()
    const one = folder('app')
    const two = folder('app')
    const server = await startServer({ port: 0, stateRoot, webDist: stateRoot })
    const projects = async () => (await (await fetch(`${server.url}/api/projects`)).json()).data as Array<{ path: string; name: string; projectId?: string; workspaceId?: string }>
    try {
      for (const path of [one, two]) {
        await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
      }
      const first = await projects()
      expect(first.map((p) => p.name)).toEqual(['app', 'app'])
      expect(new Set(first.map((p) => p.projectId)).size).toBe(2)
      expect(first.every((p) => p.workspaceId && p.projectId)).toBe(true)
      expect(await projects()).toEqual(first)

      const bad = '[{"path":'
      writeFileSync(join(stateRoot, 'projects.json'), bad)
      const failed = await fetch(`${server.url}/api/projects`)
      expect(failed.status).toBe(409)
      expect((await failed.json()).error).toMatch(/preserved/)
      expect((await fetch(`${server.url}/api/threads`)).status).toBe(200)
      expect(readFileSync(join(stateRoot, 'projects.json'), 'utf8')).toBe(bad)
    } finally {
      await server.close()
    }
  })
})
