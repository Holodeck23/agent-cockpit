import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitState } from '../server/git/branches.ts'
import { baseFile, fileDiff, listChanges, MAX_PATHS, parseNumstat, parseStatusV2, type Changes } from '../server/git/changes.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })
const gitTry = (cwd: string, ...args: string[]): void => { try { git(cwd, ...args) } catch { /* a conflicting merge exits non-zero */ } }

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

const inRepo = async (root: string): Promise<Changes> => {
  const changes = await listChanges(root)
  if (!changes.repo) throw new Error('expected a repository')
  return changes
}

describe('uncommitted changes (J4, W7-03)', () => {
  it('reads porcelain v2 -z: branch, staged/unstaged, rename, conflict, submodule and untracked, names whole', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111', '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa aaa a b.txt',
      '1 A. N... 000000 100644 100644 000 bbb new.ts',
      '2 R. N... 100644 100644 100644 ccc ccc R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 d1 d2 d3 both.txt',
      '1 .M SCM. 160000 160000 160000 e1 e1 lib',
      '? notes/x y.md', '',
    ].join('\0')
    const state = parseStatusV2(out)
    expect(state.head).toBe('1111111111111111111111111111111111111111')
    expect(state.branch).toBe('main')
    expect(state.entries).toEqual([
      { path: 'a b.txt', status: 'modified', staged: false, unstaged: true, mode: '100644' },
      { path: 'new.ts', status: 'added', staged: true, unstaged: false, mode: '100644' },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed', staged: true, unstaged: false, mode: '100644' },
      { path: 'both.txt', status: 'conflicted', staged: true, unstaged: true, mode: '100644' },
      { path: 'lib', status: 'modified', staged: false, unstaged: true, mode: '160000', submodule: { commitChanged: true, modified: true, untracked: false } },
      { path: 'notes/x y.md', status: 'untracked', staged: false, unstaged: true },
    ])
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0')).toEqual({ head: null, branch: null, entries: [] })
  })
  it('reads numstat -z, binary files as no counts', () => {
    expect(parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0')).toEqual(new Map([['a.txt', { additions: 3, deletions: 1 }], ['img.png', { binary: true }]]))
  })

  it('lists staged, unstaged, untracked, renamed, deleted, binary and conflicted files exactly', async () => {
    const root = repo()
    writeFileSync(join(root, 'both.txt'), 'base\n')
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'both')
    git(root, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(root, 'both.txt'), 'theirs\n')
    git(root, 'commit', '-q', '-am', 'theirs')
    git(root, 'checkout', '-q', 'main')
    writeFileSync(join(root, 'both.txt'), 'ours\n')
    git(root, 'commit', '-q', '-am', 'ours')
    gitTry(root, 'merge', '-q', 'other')
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    git(root, 'add', 'a.txt')
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
    rmSync(join(root, 'gone.txt'))
    git(root, 'mv', 'old name.txt', 'new name.txt')
    writeFileSync(join(root, 'fresh.md'), 'hello\nworld\n')
    writeFileSync(join(root, 'pic.bin'), Buffer.from([1, 0, 2, 0, 3]))
    const changes = await inRepo(root)
    expect(changes.base).toBe('head')
    expect(changes.head).toMatch(/^[0-9a-f]{40}$/)
    expect(changes.branch).toBe('main')
    expect(changes.conflicted).toBe(1)
    expect(changes.total).toBe(6)
    expect(changes.files.filter((f) => f.path !== 'both.txt')).toEqual([
      { path: 'a.txt', status: 'modified', staged: true, unstaged: true, additions: 3, deletions: 1 },
      { path: 'fresh.md', status: 'untracked', staged: false, unstaged: true, additions: 2, deletions: 0 },
      { path: 'gone.txt', status: 'deleted', staged: false, unstaged: true, additions: 0, deletions: 1 },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed', staged: true, unstaged: false, additions: 0, deletions: 0 },
      { path: 'pic.bin', status: 'untracked', staged: false, unstaged: true, binary: true },
    ])
    expect(changes.files.find((f) => f.path === 'both.txt')).toMatchObject({ status: 'conflicted', staged: true, unstaged: true })
    expect((await fileDiff(root, 'both.txt')).status).toBe('conflicted')
    expect((await fileDiff(root, 'pic.bin')).omitted).toBe('binary')
  })

  it('works before the first commit against an empty base, and says when a folder is not a repository', async () => {
    const root = repo(false)
    const unborn = await inRepo(root)
    expect(unborn.head).toBeNull()
    expect(unborn.base).toBe('empty')
    expect(unborn.files.map((f) => `${f.status}:${f.path}`)).toEqual(['untracked:a.txt', 'untracked:gone.txt', 'untracked:old name.txt'])
    expect((await baseFile(root, 'a.txt')).omitted).toBe('not-in-base')
    const plain = await listChanges(mkdtempSync(join(tmpdir(), 'cockpit-plain-')))
    expect(plain.repo).toBe(false)
    expect('files' in plain).toBe(false)
  })

  it('diffs one changed file with current (new) and historical (old) line numbers', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(root, 'fresh.md'), 'hello\n')
    const modified = await fileDiff(root, 'a.txt')
    expect(modified.binary).toBe(false)
    expect(modified.lines).toEqual(expect.arrayContaining([{ kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: 'TWO', new: 2 }]))
    expect((await fileDiff(root, 'fresh.md')).lines).toEqual([{ kind: 'hunk', text: '@@ -0,0 +1,1 @@' }, { kind: 'add', text: 'hello', new: 1 }])
    // The left side is the base revision, labelled with it.
    const base = await baseFile(root, 'a.txt')
    expect(base).toEqual({ path: 'a.txt', revision: git(root, 'rev-parse', 'HEAD').trim(), text: 'one\ntwo\nthree\n' })
  })

  it('a deleted or renamed path reads its base copy by its old name', async () => {
    const root = repo()
    rmSync(join(root, 'gone.txt'))
    git(root, 'mv', 'old name.txt', 'new name.txt')
    expect((await baseFile(root, 'gone.txt')).text).toBe('bye\n')
    expect((await baseFile(root, 'new name.txt')).path).toBe('old name.txt')
  })

  it('only diffs a path that is in the changes: nothing outside the project, nothing unchanged', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    await expect(fileDiff(root, 'gone.txt')).rejects.toThrow(/not changed/)
    await expect(fileDiff(root, '../../etc/passwd')).rejects.toThrow(/not changed/)
    await expect(fileDiff(root, '--output=/tmp/x')).rejects.toThrow(/not changed/)
    await expect(baseFile(root, '../../etc/passwd')).rejects.toThrow(/not changed/)
  })

  it('never runs an external diff, textconv or fsmonitor helper from the repository config, nor does the branch pill', async () => {
    const root = repo()
    const marker = join(root, '..', 'helper-ran')
    const helper = join(root, '..', 'helper.sh')
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`)
    chmodSync(helper, 0o755)
    git(root, 'config', 'diff.external', helper)
    git(root, 'config', 'diff.evil.textconv', helper)
    git(root, 'config', 'core.fsmonitor', helper)
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=evil\n')
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\n')
    await listChanges(root)
    const diff = await fileDiff(root, 'a.txt')
    await baseFile(root, 'a.txt')
    await gitState(root)
    expect(diff.lines).toEqual(expect.arrayContaining([{ kind: 'add', text: 'TWO', new: 2 }]))
    expect(existsSync(marker)).toBe(false)
  })
})

describe('bounds and boundaries (W7-04)', () => {
  it('a huge list shows the first paths with the full count; a huge file or diff says what was left out', async () => {
    const root = repo()
    mkdirSync(join(root, 'many'))
    for (let i = 0; i < MAX_PATHS + 20; i++) writeFileSync(join(root, 'many', `f${String(i).padStart(4, '0')}.txt`), 'x\n')
    writeFileSync(join(root, 'big.txt'), 'y'.repeat(1024 * 1024 + 10))
    writeFileSync(join(root, 'a.txt'), 'z\n'.repeat(25_000))
    const changes = await inRepo(root)
    expect(changes.total).toBe(MAX_PATHS + 22)
    expect(changes.files).toHaveLength(MAX_PATHS)
    expect(changes.truncated).toBe(true)
    expect(await fileDiff(root, 'big.txt')).toMatchObject({ omitted: 'too-large', lines: [] })
    const long = await fileDiff(root, 'a.txt')
    expect(long.truncated).toBe(true)
    expect(long.lines.length).toBeLessThanOrEqual(20_000)
  })

  it('a symlink is shown as one and never read through, also when it points outside the workspace', async () => {
    const root = repo()
    const secret = join(root, '..', 'secret.txt')
    writeFileSync(secret, 'TOP SECRET\n')
    symlinkSync(secret, join(root, 'leak'))
    mkdirSync(join(root, '..', 'outside-dir'))
    writeFileSync(join(root, '..', 'outside-dir', 'inner.txt'), 'TOP SECRET\n')
    symlinkSync(join(root, '..', 'outside-dir'), join(root, 'linked-dir'))
    const changes = await inRepo(root)
    expect(changes.files.find((f) => f.path === 'leak')).toEqual({ path: 'leak', status: 'untracked', staged: false, unstaged: true, symlink: true })
    expect(changes.files.some((f) => f.path.startsWith('linked-dir/'))).toBe(false)
    const diff = await fileDiff(root, 'leak')
    expect(diff).toMatchObject({ omitted: 'symlink', symlinkTarget: secret, lines: [] })
    expect(JSON.stringify(diff)).not.toContain('TOP SECRET')
  })
})

describe('GET /api/git/changes, /api/git/diff and /api/git/base', () => {
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
      const base = await (await get(`/api/git/base?${q({ path: 'a.txt' })}`)).json() as { data: { text: string } }
      expect(base.data.text).toBe('one\ntwo\nthree\n')
    } finally {
      await server.close()
    }
  })
})
