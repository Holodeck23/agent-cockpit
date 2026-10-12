import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../../server/projects/workspaces.ts'
import { createWorktreeService } from '../../server/projects/worktrees.ts'
import { createMergeService } from '../../server/projects/merge.ts'

// u12-2: a recorded merge conflict that the person resolves (or aborts) outside Cockpit, in a
// terminal or with an agent in the main checkout, must not leave the journal stuck in 'conflict'.
// Correct behaviour: once the repository no longer shows that merge, preflight reports no open
// operation and no "waiting" blocker, and a later merge of the same worktree can go ahead.

const ident = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
beforeAll(() => { Object.assign(process.env, ident) })
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...ident }, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, message: string): string => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

async function conflicted() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-audit-u12-2-')))
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
  const service = createMergeService(state, { workspaces, activeIn: () => [] })
  commit(wt.cwd, 'beds.txt', 'roses\nlilies\n', 'worktree edit')
  commit(repo, 'beds.txt', 'roses\ndaisies\n', 'main edit')
  const op = await service.merge(wt.id, (await service.preflight(wt.id)).fingerprint)
  expect(op).toMatchObject({ stage: 'conflict', conflicts: ['beds.txt'] })
  return { repo, wt, service, op }
}

describe('u12-2: a conflict settled outside Cockpit must not block the worktree forever', () => {
  it('resolved by hand and committed in a terminal: no open operation, no waiting blocker, later merge works', async () => {
    const { repo, wt, service } = await conflicted()
    writeFileSync(join(repo, 'beds.txt'), 'by hand\n')
    git(repo, 'add', 'beds.txt')
    git(repo, 'commit', '-q', '--no-edit')

    const check = await service.preflight(wt.id)
    expect(check.open).toBeUndefined()
    expect(check.blockers).not.toContain('A merge of this worktree is waiting: continue or abort it first.')

    // The worktree keeps working: a new commit there can be merged back.
    commit(wt.cwd, 'roses.txt', 'red\n', 'more roses')
    const next = await service.preflight(wt.id)
    expect(next.blockers).toEqual([])
    expect(await service.merge(wt.id, next.fingerprint)).toMatchObject({ stage: 'merged' })
  })

  it('aborted with git merge --abort in a terminal: no open operation, no waiting blocker', async () => {
    const { repo, wt, service } = await conflicted()
    git(repo, 'merge', '--abort')

    const check = await service.preflight(wt.id)
    expect(check.open).toBeUndefined()
    expect(check.blockers).not.toContain('A merge of this worktree is waiting: continue or abort it first.')
    expect(check.blockers).toEqual([])
  })
})
