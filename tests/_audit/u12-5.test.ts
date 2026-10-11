import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// u12-5: the removal check ran `git status` through out(), which turns ANY git failure (15 s timeout, 2 MB
// output cap) into undefined, then `?? ''`, so a status that could not be read counted as 0 changed / 0
// untracked / 0 ignored. Git's own `worktree remove` (no --force) does not protect ignored files, so the
// ignored count is the only guard for a .env or build output: with it blind, remove() deleted them.
// Correct behaviour: a worktree whose state cannot be read is never removable, and is never removed.

const hold = vi.hoisted(() => ({ failStatus: false }))
vi.mock('../../server/git/branches.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/git/branches.ts')>()
  return {
    ...actual,
    run: (cwd: string, args: readonly string[], ...rest: unknown[]) =>
      hold.failStatus && args[0] === 'status'
        ? Promise.reject(new actual.GitError('git status took longer than 15 s and was stopped'))
        : (actual.run as (...a: unknown[]) => Promise<{ stdout: string; stderr: string }>)(cwd, args, ...rest),
  }
})

const { createWorkspaceStore } = await import('../../server/projects/workspaces.ts')
const { createWorktreeService } = await import('../../server/projects/worktrees.ts')
const { LifecycleRefusalError, createWorktreeLifecycle } = await import('../../server/projects/worktree-lifecycle.ts')

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

let dir = ''
afterEach(() => {
  hold.failStatus = false
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function worktreeWithIgnoredEnv() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-u12-5-')))
  const repo = join(dir, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.env\n*.log\n')
  writeFileSync(join(repo, 'shared.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const projectId = workspaces.primaryFor(repo)!.project.id
  const wt = await createWorktreeService(state, workspaces).create(projectId, { name: 'Secrets' })
  writeFileSync(join(wt.cwd, '.env'), 'TOKEN=keep-me\n')
  return { wt, lifecycle: createWorktreeLifecycle({ workspaces, activeIn: () => [] }) }
}

const refusal = async (promise: Promise<unknown>): Promise<{ code: string }> => {
  try { await promise } catch (error) { if (error instanceof LifecycleRefusalError) return error.refusal; throw error }
  throw new Error('expected a refusal')
}

describe('u12-5: a worktree whose state cannot be read is not removable', () => {
  it('control: an ignored .env alone makes it unremovable when status can be read', async () => {
    const { wt, lifecycle } = await worktreeWithIgnoredEnv()
    const check = await lifecycle.removalCheck(wt.id)
    expect(check).toMatchObject({ removable: false, unique: { ignored: 1 } })
  })

  it('a failed git status is a blocker, not an empty status', async () => {
    const { wt, lifecycle } = await worktreeWithIgnoredEnv()
    hold.failStatus = true
    const check = await lifecycle.removalCheck(wt.id)
    expect(check.removable).toBe(false)
    expect(check.blockers.length).toBeGreaterThan(0)

    // Even a confirmation taken from that very check removes nothing.
    expect(await refusal(lifecycle.remove(wt.id, check.fingerprint))).toMatchObject({ code: 'blocked' })
    expect(readFileSync(join(wt.cwd, '.env'), 'utf8')).toBe('TOKEN=keep-me\n')
  })

  it('a status too large for the default 2 MB read is still counted, so the ignored .env protects the folder', async () => {
    const { wt, lifecycle } = await worktreeWithIgnoredEnv()
    // Ignored one by one (`*.log`), so `git status --ignored=matching -uall` lists every file: well over 2 MB.
    const many = join(wt.cwd, 'cache')
    mkdirSync(many)
    const stem = 'x'.repeat(200)
    for (let i = 0; i < 11_000; i++) writeFileSync(join(many, `${stem}-${i}.log`), '')
    expect(execFileSync('git', ['-C', wt.cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { env, maxBuffer: 64_000_000 }).length).toBeGreaterThan(2_000_000)

    const check = await lifecycle.removalCheck(wt.id)
    expect(check.removable).toBe(false)
    expect(check.unique.ignored > 0 || check.blockers.length > 0).toBe(true)
    await lifecycle.remove(wt.id, check.fingerprint).catch(() => undefined)
    expect(existsSync(join(wt.cwd, '.env'))).toBe(true)
  }, 60_000)
})
