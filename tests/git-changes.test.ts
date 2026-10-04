import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileDiff, listChanges, parseNumstat, parsePorcelain } from '../server/git/changes.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function repo(commit = true): string {
  const root = join(mkdtempSync(join(tmpdir(), 'cockpit-changes-')), 'project')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(root, 'gone.txt'), 'bye\n')
  writeFileSync(join(root, 'old name.txt'), 'same\n'.repeat(20))
  if (commit) { git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first') }
  return root
}

describe('uncommitted changes (J4)', () => {
  it('reads porcelain -z: modified, added, deleted, renamed and untracked, with spaces in names', () => {
    expect(parsePorcelain(' M a.txt\0A  new.ts\0 D gone.txt\0R  new name.txt\0old name.txt\0?? notes/x y.md\0')).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'new.ts', status: 'added' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' },
      { path: 'notes/x y.md', status: 'untracked' },
    ])
  })
  it('reads numstat -z, binary files as no counts', () => {
    expect(parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0')).toEqual(new Map([['a.txt', { additions: 3, deletions: 1 }], ['img.png', { binary: true }]]))
  })

  it('lists a real repository’s changes with line counts', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    rmSync(join(root, 'gone.txt'))
    git(root, 'mv', 'old name.txt', 'new name.txt')
    writeFileSync(join(root, 'fresh.md'), 'hello\nworld\n')
    const changes = await listChanges(root)
    expect(changes.repo).toBe(true)
    expect(changes.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'fresh.md', status: 'untracked', additions: 2, deletions: 0 },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed', additions: 0, deletions: 0 },
    ])
  })

  it('works before the first commit, and says when a folder is not a repository', async () => {
    const root = repo(false)
    expect((await listChanges(root)).files.map((f) => `${f.status}:${f.path}`)).toEqual(['untracked:a.txt', 'untracked:gone.txt', 'untracked:old name.txt'])
    expect(await listChanges(mkdtempSync(join(tmpdir(), 'cockpit-plain-')))).toEqual({ repo: false, files: [] })
  })

  it('diffs one changed file; an untracked file is all additions', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(root, 'fresh.md'), 'hello\n')
    const modified = await fileDiff(root, 'a.txt')
    expect(modified.binary).toBe(false)
    expect(modified.lines).toEqual(expect.arrayContaining([{ kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: 'TWO', new: 2 }]))
    expect((await fileDiff(root, 'fresh.md')).lines).toEqual([{ kind: 'hunk', text: '@@ -0,0 +1,1 @@' }, { kind: 'add', text: 'hello', new: 1 }])
  })

  it('only diffs a path that is in the changes: nothing outside the project, nothing unchanged', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    await expect(fileDiff(root, 'gone.txt')).rejects.toThrow(/not changed/)
    await expect(fileDiff(root, '../../etc/passwd')).rejects.toThrow(/not changed/)
    await expect(fileDiff(root, '--output=/tmp/x')).rejects.toThrow(/not changed/)
  })
})

describe('GET /api/git/changes and /api/git/diff', () => {
  it('serve an open project only', async () => {
    const { startServer } = await import('../server/start.ts')
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-changes-state-')), webDist: root })
    const get = (path: string) => fetch(`${server.url}${path}`)
    const q = (extra = {}) => new URLSearchParams({ projectPath: root, ...extra })
    try {
      expect((await get(`/api/git/changes?${q()}`)).status).toBe(404)
      await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })
      const changes = await (await get(`/api/git/changes?${q()}`)).json() as { data: { files: Array<{ path: string }> } }
      expect(changes.data.files.map((f) => f.path)).toEqual(['a.txt'])
      expect((await get(`/api/git/diff?${q({ path: 'a.txt' })}`)).status).toBe(200)
      expect((await get(`/api/git/diff?${q({ path: 'README.md' })}`)).status).toBe(409)
    } finally {
      await server.close()
    }
  })
})
