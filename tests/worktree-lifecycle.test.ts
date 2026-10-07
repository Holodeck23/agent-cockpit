import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspaceStore, type Workspace } from '../server/projects/workspaces.ts'
import { createWorktreeService, parseWorktreeList } from '../server/projects/worktrees.ts'
import { LifecycleRefusalError, countStatus, createWorktreeLifecycle, type LifecycleRefusal } from '../server/projects/worktree-lifecycle.ts'

// Order 18a (W12-12, W12-13, W12-14): a worktree is removed only when nothing unique would go with
// it, with plain Git removal and its branch kept; anything else is kept or archived as it is; and
// what Git says about each registered worktree is reported, never pruned or recreated.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

async function setup(active: (w: Workspace) => readonly string[] = () => []) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-lifecycle-')))
  const repo = join(dir, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  writeFileSync(join(repo, 'shared.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const projectId = workspaces.primaryFor(repo)!.project.id
  const worktrees = createWorktreeService(state, workspaces)
  const lifecycle = createWorktreeLifecycle({ workspaces, activeIn: active })
  const make = (name: string) => worktrees.create(projectId, { name })
  return { dir, repo, workspaces, projectId, lifecycle, make }
}

async function refusal(promise: Promise<unknown>): Promise<LifecycleRefusal> {
  try { await promise } catch (error) { if (error instanceof LifecycleRefusalError) return error.refusal; throw error }
  throw new Error('expected a refusal')
}
const listed = (repo: string): string[] => parseWorktreeList(git(repo, 'worktree', 'list', '--porcelain', '-z')).map((w) => w.path)

describe('removing and archiving worktrees (W12-12, W12-13)', () => {
  it('removes a clean, fully merged worktree with Git, keeps its branch, and refuses an old confirmation', async () => {
    const { repo, workspaces, lifecycle, make } = await setup()
    const w = await make('Tidy')
    const check = await lifecycle.removalCheck(w.id)
    expect(check).toMatchObject({ removable: true, blockers: [], unique: { changed: 0, untracked: 0, ignored: 0, commits: 0 }, branch: 'codex/tidy' })

    // Something changes after the check: the old confirmation no longer removes anything.
    git(w.cwd, 'commit', '-q', '--allow-empty', '-m', 'later')
    git(repo, 'branch', 'keep-later', git(w.cwd, 'rev-parse', 'HEAD'))
    expect(await refusal(lifecycle.remove(w.id, check.fingerprint))).toMatchObject({ code: 'stale' })
    expect(existsSync(w.cwd)).toBe(true)

    const again = await lifecycle.removalCheck(w.id)
    const removed = await lifecycle.remove(w.id, again.fingerprint)
    expect(removed).toMatchObject({ lifecycle: 'removed', ended: { path: w.cwd, branch: 'codex/tidy', head: again.head } })
    expect(existsSync(w.cwd)).toBe(false)
    expect(listed(repo)).toEqual([repo])
    expect(git(repo, 'branch', '--list', 'codex/tidy')).toContain('codex/tidy')
    expect(workspaces.get(w.id)?.lifecycle).toBe('removed')
  })

  it('refuses removal while any unique work is there: changes, untracked, ignored files, unmerged commits', async () => {
    const { lifecycle, make } = await setup()
    const cases: Array<[string, (cwd: string) => void, Partial<Record<'changed' | 'untracked' | 'ignored' | 'commits', number>>]> = [
      ['changed', (cwd) => writeFileSync(join(cwd, 'shared.txt'), 'edited\n'), { changed: 1 }],
      ['untracked', (cwd) => writeFileSync(join(cwd, 'new.txt'), 'new\n'), { untracked: 1 }],
      ['ignored', (cwd) => { mkdirSync(join(cwd, 'build')); writeFileSync(join(cwd, 'build', 'out.js'), '1\n') }, { ignored: 1 }],
      ['commits', (cwd) => { writeFileSync(join(cwd, 'c.txt'), 'c\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'only here') }, { commits: 1 }],
    ]
    for (const [name, change, expected] of cases) {
      const w = await make(`Case ${name}`)
      change(w.cwd)
      const check = await lifecycle.removalCheck(w.id)
      expect(check.removable, name).toBe(false)
      expect(check.unique, name).toMatchObject(expected)
      expect(await refusal(lifecycle.remove(w.id, check.fingerprint)), name).toMatchObject({ code: 'unique-work' })
      expect(existsSync(w.cwd), name).toBe(true)
    }
  })

  it('refuses removal and archiving while work runs in it, and during a Git operation', async () => {
    let busy: string[] = ['A conversation is working in it.']
    const { lifecycle, make } = await setup(() => busy)
    const w = await make('Busy')
    const check = await lifecycle.removalCheck(w.id)
    expect(check.blockers).toEqual(['A conversation is working in it.'])
    expect(await refusal(lifecycle.remove(w.id, check.fingerprint))).toMatchObject({ code: 'blocked' })
    expect(await refusal(lifecycle.archive(w.id))).toMatchObject({ code: 'blocked' })

    busy = []
    const gitDir = git(w.cwd, 'rev-parse', '--absolute-git-dir')
    writeFileSync(join(gitDir, 'MERGE_HEAD'), `${git(w.cwd, 'rev-parse', 'HEAD')}\n`)
    expect((await lifecycle.removalCheck(w.id)).blockers).toEqual(['A Git merge is in progress in it.'])
    rmSync(join(gitDir, 'MERGE_HEAD'))
    expect((await lifecycle.removalCheck(w.id)).removable).toBe(true)
  })

  it('archives a worktree with unique work exactly as it is, and restores it', async () => {
    const { workspaces, lifecycle, make } = await setup()
    const w = await make('Keep me')
    writeFileSync(join(w.cwd, 'draft.txt'), 'unique\n')
    const archived = await lifecycle.archive(w.id)
    expect(archived).toMatchObject({ lifecycle: 'archived', ended: { path: w.cwd, branch: 'codex/keep-me' } })
    expect(readFileSync(join(w.cwd, 'draft.txt'), 'utf8')).toBe('unique\n')
    expect(await refusal(lifecycle.archive(w.id))).toMatchObject({ code: 'not-active' })
    const restored = await lifecycle.restore(w.id)
    expect(restored.lifecycle).toBe('active')
    expect(restored.ended).toBeUndefined()
    expect(workspaces.get(w.id)?.lifecycle).toBe('active')
  })

  it('never acts on the main checkout or an unknown workspace', async () => {
    const { repo, workspaces, lifecycle } = await setup()
    const primary = workspaces.primaryFor(repo)!.workspace
    expect(await refusal(lifecycle.removalCheck(primary.id))).toMatchObject({ code: 'not-a-worktree' })
    expect(await refusal(lifecycle.archive(primary.id))).toMatchObject({ code: 'not-a-worktree' })
    expect(await refusal(lifecycle.removalCheck('00000000-0000-4000-8000-000000000000'))).toMatchObject({ code: 'unknown-workspace' })
    expect(existsSync(repo)).toBe(true)
  })
})

describe('what Git says about registered worktrees (W12-14)', () => {
  it('reports moved, missing, unlisted and unregistered worktrees without pruning or recreating', async () => {
    const { dir, repo, projectId, lifecycle, make } = await setup()
    const moved = await make('Moved')
    const deleted = await make('Deleted')
    const unlisted = await make('Unlisted')
    const healthy = await make('Healthy')
    const elsewhere = join(dir, 'moved-here')
    git(repo, 'worktree', 'move', moved.cwd, elsewhere)
    rmSync(deleted.cwd, { recursive: true, force: true })
    const external = join(dir, 'made-outside')
    git(repo, 'worktree', 'add', '-q', '-b', 'outside', external)
    // A folder Git stops listing (its admin entry in the main repository is gone) while the files stay.
    rmSync(git(unlisted.cwd, 'rev-parse', '--absolute-git-dir'), { recursive: true, force: true })
    const before = listed(repo)

    const { worktrees, unregistered } = await lifecycle.health(projectId)
    expect(worktrees[healthy.id]).toEqual({ state: 'ok' })
    expect(worktrees[moved.id]).toMatchObject({ state: 'moved', path: elsewhere })
    expect(worktrees[deleted.id]).toMatchObject({ state: 'missing' })
    expect(worktrees[unlisted.id]).toMatchObject({ state: 'unlisted' })
    expect(unregistered.map((w) => w.path)).toEqual(expect.arrayContaining([elsewhere, external]))

    // Reporting changed nothing: Git still lists what it listed, and no folder came back.
    expect(listed(repo)).toEqual(before)
    expect(existsSync(deleted.cwd)).toBe(false)
    expect(existsSync(moved.cwd)).toBe(false)
  })

  it('forgets only a worktree whose folder is gone, leaving Git\'s records alone', async () => {
    const { repo, lifecycle, make } = await setup()
    const gone = await make('Gone')
    const here = await make('Here')
    rmSync(gone.cwd, { recursive: true, force: true })
    const before = listed(repo)
    expect(await refusal(lifecycle.forget(here.id))).toMatchObject({ code: 'not-missing' })
    expect((await lifecycle.forget(gone.id))).toMatchObject({ lifecycle: 'removed', ended: { path: gone.cwd } })
    expect(listed(repo)).toEqual(before)
  })

  it('restores an archived worktree only where Git still has it', async () => {
    const { dir, repo, lifecycle, make } = await setup()
    const w = await make('Away')
    await lifecycle.archive(w.id)
    renameSync(w.cwd, join(dir, 'renamed-by-hand'))
    expect(await refusal(lifecycle.restore(w.id))).toMatchObject({ code: 'not-restorable' })
    expect(existsSync(repo)).toBe(true)
  })
})

describe('counting git status', () => {
  it('counts changed, untracked and ignored entries, a rename once', () => {
    expect(countStatus(' M a\0?? b\0!! c/\0R  new\0old\0')).toEqual({ changed: 2, untracked: 1, ignored: 1 })
    expect(countStatus('')).toEqual({ changed: 0, untracked: 0, ignored: 0 })
  })
})
