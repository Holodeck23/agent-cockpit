import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceStore, type Workspace } from '../server/projects/workspaces.ts'
import { createWorktreeService } from '../server/projects/worktrees.ts'
import { MergeRefusalError, createMergeService, type MergeRefusal } from '../server/projects/merge.ts'

// Order 18c (W12-09, W12-10, W12-11): a worktree's branch merges back into the main checkout with
// Git's own merge; a changed HEAD after approval is refused; dirty or busy checkouts are never
// stashed or reset; a conflict is a recorded state with Continue and Abort; a crash part way
// reopens that state and never merges twice. Nothing is pushed and the worktree stays.

const ident = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
beforeAll(() => { Object.assign(process.env, ident) })
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...ident }, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, message: string): string => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

async function setup(active: (w: Workspace) => readonly string[] = () => [], beforeMerge?: () => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-merge-')))
  const repo = join(dir, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  commit(repo, 'beds.txt', 'roses\ntulips\n', 'first')
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const projectId = workspaces.primaryFor(repo)!.project.id
  const wt = await createWorktreeService(state, workspaces).create(projectId, { name: 'Rose bed' })
  const service = createMergeService(state, { workspaces, activeIn: active }, beforeMerge ? { beforeMerge } : {})
  return { dir, repo, state, workspaces, wt, service }
}
async function refusal(promise: Promise<unknown>): Promise<MergeRefusal> {
  try { await promise } catch (error) { if (error instanceof MergeRefusalError) return error.refusal; throw error }
  throw new Error('expected a refusal')
}
const parents = (repo: string): number => git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length - 1

describe('merging a worktree back (W12-09)', () => {
  it('fast-forwards when the main checkout has not moved; the worktree and its branch stay', async () => {
    const { repo, wt, service } = await setup()
    const head = commit(wt.cwd, 'roses.txt', 'red\n', 'roses')
    const check = await service.preflight(wt.id)
    expect(check).toMatchObject({ mode: 'fast-forward', commits: 1, targetBranch: 'main', sourceBranch: 'codex/rose-bed', blockers: [], files: [{ status: 'A', path: 'roses.txt' }] })
    const done = await service.merge(wt.id, check.fingerprint)
    expect(done).toMatchObject({ stage: 'merged', resultHead: head })
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(wt.cwd)).toBe(true)
    expect(git(repo, 'branch', '--list', 'codex/rose-bed')).toContain('codex/rose-bed')
    expect((await service.preflight(wt.id)).mode).toBe('up-to-date')
  })

  it('makes an explicit merge commit when both sides moved', async () => {
    const { repo, wt, service } = await setup()
    commit(wt.cwd, 'roses.txt', 'red\n', 'roses')
    commit(repo, 'pond.txt', 'koi\n', 'pond')
    const check = await service.preflight(wt.id)
    expect(check.mode).toBe('merge')
    expect(await service.merge(wt.id, check.fingerprint)).toMatchObject({ stage: 'merged' })
    expect(parents(repo)).toBe(2)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge codex/rose-bed into main')
  })

  it('refuses an approval made before the main checkout moved; nothing is merged', async () => {
    const { repo, wt, service } = await setup()
    commit(wt.cwd, 'roses.txt', 'red\n', 'roses')
    const check = await service.preflight(wt.id)
    const moved = commit(repo, 'pond.txt', 'koi\n', 'someone else')
    expect(await refusal(service.merge(wt.id, check.fingerprint))).toMatchObject({ code: 'stale' })
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(moved)
  })
})

describe('what blocks a merge (W12-10)', () => {
  it('refuses dirty or busy checkouts and never stashes, resets or touches their files', async () => {
    let busy: string[] = []
    const { repo, wt, service } = await setup(() => busy)
    commit(wt.cwd, 'roses.txt', 'red\n', 'roses')
    writeFileSync(join(repo, 'notes.txt'), 'mine, not committed\n')
    const dirty = await service.preflight(wt.id)
    expect(dirty.blockers.join(' ')).toContain('main checkout has uncommitted changes or untracked files')
    expect(await refusal(service.merge(wt.id, dirty.fingerprint))).toMatchObject({ code: 'blocked' })
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine, not committed\n')
    expect(git(repo, 'stash', 'list')).toBe('')

    execFileSync('rm', [join(repo, 'notes.txt')])
    busy = ['A conversation is working in it.']
    expect((await service.preflight(wt.id)).blockers).toEqual(expect.arrayContaining(['Worktree: A conversation is working in it.', 'Main checkout: A conversation is working in it.']))
  })
})

describe('conflicts and recovery (W12-11)', () => {
  const conflicted = async (beforeMerge?: () => void) => {
    const s = await setup(undefined, beforeMerge)
    commit(s.wt.cwd, 'beds.txt', 'roses\nlilies\n', 'worktree edit')
    commit(s.repo, 'beds.txt', 'roses\ndaisies\n', 'main edit')
    return s
  }

  it('records the exact conflicted paths; Continue waits for resolution and then commits the merge', async () => {
    const { repo, wt, service } = await conflicted()
    const check = await service.preflight(wt.id)
    const op = await service.merge(wt.id, check.fingerprint)
    expect(op).toMatchObject({ stage: 'conflict', conflicts: ['beds.txt'] })
    expect((await service.preflight(wt.id)).open).toMatchObject({ id: op.id, stage: 'conflict' })
    expect(await refusal(service.continue(op.id))).toMatchObject({ code: 'still-conflicted', paths: ['beds.txt'] })
    writeFileSync(join(repo, 'beds.txt'), 'roses\nlilies\ndaisies\n')
    git(repo, 'add', 'beds.txt')
    expect(await service.continue(op.id)).toMatchObject({ stage: 'merged' })
    expect(parents(repo)).toBe(2)
    expect(readFileSync(join(repo, 'beds.txt'), 'utf8')).toBe('roses\nlilies\ndaisies\n')
  })

  it('Abort uses Git\'s own abort for this merge only, and refuses once the repository no longer matches it', async () => {
    const first = await conflicted()
    const before = git(first.repo, 'rev-parse', 'HEAD')
    const op = await first.service.merge(first.wt.id, (await first.service.preflight(first.wt.id)).fingerprint)
    expect(await first.service.abort(op.id)).toMatchObject({ stage: 'aborted' })
    expect(git(first.repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(first.repo, 'status', '--porcelain')).toBe('')

    const second = await conflicted()
    const op2 = await second.service.merge(second.wt.id, (await second.service.preflight(second.wt.id)).fingerprint)
    // Someone resolves it by hand and commits: the recorded merge is no longer what is there.
    writeFileSync(join(second.repo, 'beds.txt'), 'by hand\n')
    git(second.repo, 'add', 'beds.txt')
    git(second.repo, 'commit', '-q', '--no-edit')
    const after = git(second.repo, 'rev-parse', 'HEAD')
    // Files kept, and the next manual step named (W12.3).
    expect(await refusal(second.service.abort(op2.id))).toMatchObject({ code: 'unsafe', detail: expect.stringContaining('git status') })
    expect(git(second.repo, 'rev-parse', 'HEAD')).toBe(after)
  })

  it('a crash part way reopens the recorded conflict and never merges again', async () => {
    let crashed = false
    const { repo, state, workspaces, wt } = await conflicted()
    const crashing = createMergeService(state, { workspaces, activeIn: () => [] }, {
      beforeMerge: () => {
        // Git starts the merge, then Cockpit dies before it records the outcome.
        try { git(repo, 'merge', '--no-ff', '--no-edit', git(wt.cwd, 'rev-parse', 'HEAD')) } catch { /* conflict */ }
        crashed = true
        throw new Error('crash')
      },
    })
    await expect(crashing.merge(wt.id, (await crashing.preflight(wt.id)).fingerprint)).rejects.toThrow('crash')
    expect(crashed).toBe(true)
    const reopened = createMergeService(state, { workspaces, activeIn: () => [] })
    const check = await reopened.preflight(wt.id)
    expect(check.open).toMatchObject({ stage: 'conflict', conflicts: ['beds.txt'] })
    expect(await refusal(reopened.merge(wt.id, check.fingerprint))).toMatchObject({ code: 'blocked' })
    expect(await reopened.abort(check.open!.id)).toMatchObject({ stage: 'aborted' })
  })

  it('a crash before Git started is reported as nothing merged, and a new check merges once', async () => {
    const { repo, state, workspaces, wt } = await setup()
    commit(wt.cwd, 'roses.txt', 'red\n', 'roses')
    const crashing = createMergeService(state, { workspaces, activeIn: () => [] }, { beforeMerge: () => { throw new Error('crash') } })
    await expect(crashing.merge(wt.id, (await crashing.preflight(wt.id)).fingerprint)).rejects.toThrow('crash')
    const before = git(repo, 'rev-parse', 'HEAD')
    const reopened = createMergeService(state, { workspaces, activeIn: () => [] })
    const check = await reopened.preflight(wt.id)
    expect(check.open).toBeUndefined()
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(await reopened.merge(wt.id, check.fingerprint)).toMatchObject({ stage: 'merged' })
  })
})
