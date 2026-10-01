import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBranch, gitState, insideRepository, parseStatus, pushBranch, redact, switchBranch } from '../server/git/branches.ts'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

/** A repository with one commit on main and a local bare remote called origin. */
function fixture(): { root: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-git-'))
  const root = join(base, 'project')
  const remote = join(base, 'remote.git')
  mkdirSync(root)
  git(base, 'init', '--bare', '-q', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), '# project\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'first')
  git(root, 'remote', 'add', 'origin', remote)
  return { root, remote }
}

describe('reading git status', () => {
  it('parses branch, upstream, ahead/behind and changed paths', () => {
    const parsed = parseStatus([
      '# branch.oid 0123456789abcdef', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.ts', '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts\told.ts', '? notes.txt',
    ].join('\n'))
    expect(parsed).toEqual({ branch: 'feature/x', head: '0123456', upstream: 'origin/feature/x', ahead: 2, behind: 1,
      changes: ['src/app.ts', 'new name.ts', 'notes.txt'], changeCount: 3 })
  })

  it('reports a detached HEAD and an empty repository without a branch or commit', () => {
    expect(parseStatus('# branch.oid abcdef1234\n# branch.head (detached)\n')).toEqual({ head: 'abcdef1', changes: [], changeCount: 0 })
    expect(parseStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual({ branch: 'main', changes: [], changeCount: 0 })
  })

  it('hides credentials in remote URLs', () => {
    expect(redact("fatal: unable to access 'https://me:ghp_secret@github.com/x/y.git/'")).toBe("fatal: unable to access 'https://***@github.com/x/y.git/'")
  })

  it('does not run git for a folder outside any repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cockpit-plain-'))
    expect(insideRepository(plain)).toBe(false)
    expect(await gitState(plain)).toEqual({ repo: false, branches: [], changes: [], changeCount: 0 })
  })

  it('reads a real repository, including from a subfolder', async () => {
    const { root } = fixture()
    mkdirSync(join(root, 'web'))
    const state = await gitState(join(root, 'web'))
    expect(state).toMatchObject({ repo: true, branch: 'main', branches: ['main'], changeCount: 0 })
    expect(state.head).toMatch(/^[0-9a-f]{7}$/)
  })
})

describe('branch actions', () => {
  it('creates and switches, carrying uncommitted changes onto a new branch', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'draft.md'), 'wip\n')
    const created = await createBranch(root, 'feature/one')
    expect(created).toMatchObject({ branch: 'feature/one', changeCount: 1, changes: ['draft.md'] })
    expect(created.branches).toEqual(expect.arrayContaining(['main', 'feature/one']))
    await expect(createBranch(root, 'feature/one')).rejects.toThrow('already exists')
    await expect(createBranch(root, '-x')).rejects.toThrow('Not a valid branch name')
    await expect(createBranch(root, 'bad..name')).rejects.toThrow('Not a valid branch name')
  })

  it('refuses to switch with uncommitted changes and names them', async () => {
    const { root } = fixture()
    await createBranch(root, 'other')
    writeFileSync(join(root, 'README.md'), '# changed\n')
    await expect(switchBranch(root, 'main')).rejects.toThrow('Commit or stash first: 1 uncommitted change (README.md)')
    git(root, 'commit', '-q', '-am', 'change')
    expect(await switchBranch(root, 'main')).toMatchObject({ branch: 'main', changeCount: 0 })
    await expect(switchBranch(root, 'nope')).rejects.toThrow('No local branch called nope')
  })

  it('pushes a new branch to origin with an upstream, then pushes again to it', async () => {
    const { root, remote } = fixture()
    const first = await pushBranch(root)
    expect(first.to).toBe('origin/main')
    expect(first.state.upstream).toBe('origin/main')
    writeFileSync(join(root, 'b.txt'), 'b\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'b')
    expect((await gitState(root)).ahead).toBe(1)
    const second = await pushBranch(root)
    expect(second.state.ahead).toBe(0)
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'))
  })

  it('explains a missing remote instead of failing obscurely', async () => {
    const { root } = fixture()
    git(root, 'remote', 'remove', 'origin')
    await expect(pushBranch(root)).rejects.toThrow('This repository has no remote to push to')
  })
})

describe('/api/git', () => {
  it('reads state, switches, and refuses to switch or create while a conversation works', async () => {
    const { root } = fixture()
    await createBranch(root, 'side')
    // An agent that never finishes its turn keeps the conversation working.
    const launcher: Launcher = () => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {}, close: async () => {} })
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-git-state-')), webDist: root,
      launchers: { claude: launcher, codex: launcher } })
    const post = (path: string, body: unknown) => fetch(`${server.url}/api/git/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      expect((await fetch(`${server.url}/api/git?projectPath=${encodeURIComponent(root)}`)).status).toBe(404)
      await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })
      const read = await (await fetch(`${server.url}/api/git?projectPath=${encodeURIComponent(root)}`)).json()
      expect(read.data).toMatchObject({ repo: true, branch: 'side', busy: [] })

      const switched = await post('switch', { projectPath: root, branch: 'main' })
      expect(switched.status).toBe(200)
      expect((await switched.json()).data.branch).toBe('main')

      await fetch(`${server.url}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: root, title: 'Long job', text: 'work', settings: { agent: 'claude' } }) })
      const blocked = await post('switch', { projectPath: root, branch: 'side' })
      expect(blocked.status).toBe(409)
      expect((await blocked.json()).error).toContain('Long job')
      expect((await post('create', { projectPath: root, branch: 'new' })).status).toBe(409)
      expect(git(root, 'branch', '--show-current').trim()).toBe('main')
    } finally { await server.close() }
  })
})
