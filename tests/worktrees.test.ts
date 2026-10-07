import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKSPACES_SCHEMA_VERSION, createWorkspaceStore } from '../server/projects/workspaces.ts'
import { WorktreeRefusalError, branchSlug, createWorktreeService, parseWorktreeList, type WorktreeRefusal } from '../server/projects/worktrees.ts'

// Order 17a (W12-05, W12-06; G-WORKTREES mechanism): worktrees start from a committed state with
// a dirty primary left behind, bad input leaves nothing behind, and a create that stops between
// Git and registration is found again and registered once.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

function setup(options: { commits?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-worktrees-')))
  const repo = join(dir, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  let first = '', second = ''
  if (options.commits !== false) {
    writeFileSync(join(repo, 'shared.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    first = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'shared.txt'), 'two\n')
    git(repo, 'commit', '-q', '-am', 'second')
    second = git(repo, 'rev-parse', 'HEAD')
  }
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const projectId = workspaces.primaryFor(repo)!.project.id
  return { dir, repo, state, workspaces, projectId, first, second }
}

async function refusal(promise: Promise<unknown>): Promise<WorktreeRefusal> {
  try { await promise } catch (error) { if (error instanceof WorktreeRefusalError) return error.refusal; throw error }
  throw new Error('expected a refusal')
}

const worktreeCount = (repo: string): number => parseWorktreeList(git(repo, 'worktree', 'list', '--porcelain', '-z')).length

describe('worktree workspaces (W12-05, W12-06)', () => {
  it('starts from the chosen commit and leaves the primary\'s uncommitted files behind', async () => {
    const { repo, state, workspaces, projectId, first } = setup()
    writeFileSync(join(repo, 'shared.txt'), 'edited, not committed\n')
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n')
    const service = createWorktreeService(state, workspaces)

    const preflight = await service.preflight(projectId)
    expect(preflight).toMatchObject({ branch: 'main', uncommitted: 2, branchPrefix: 'codex/' })

    const workspace = await service.create(projectId, { name: 'Try a recovery path', base: first })
    expect(workspace).toMatchObject({ kind: 'worktree', managed: true, lifecycle: 'active', name: 'Try a recovery path',
      branch: 'codex/try-a-recovery-path', baseRef: first, baseCommit: first, createdFromBranch: 'main', createdFrom: workspaces.primaryFor(repo)!.workspace.id })
    expect(workspace.cwd.startsWith(`${repo}-worktree-`)).toBe(true)
    expect(git(workspace.cwd, 'rev-parse', 'HEAD')).toBe(first)
    expect(readFileSync(join(workspace.cwd, 'shared.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(workspace.cwd, 'scratch.txt'))).toBe(false)
    // The primary is exactly as it was.
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('edited, not committed\n')
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')

    expect(workspaces.forProject(projectId).map((w) => w.kind)).toEqual(['primary', 'worktree'])
    expect(JSON.parse(readFileSync(join(state, 'workspaces.json'), 'utf8')).schemaVersion).toBe(WORKSPACES_SCHEMA_VERSION)
    // Opening the worktree folder later does not make it a project of its own.
    workspaces.ensure([workspace.cwd])
    expect(workspaces.list().projects).toHaveLength(1)
    expect(await service.pending(projectId)).toEqual([])
  })

  it('defaults to the primary HEAD and uses a branch the person typed as typed', async () => {
    const { state, workspaces, projectId, second } = setup()
    const workspace = await createWorktreeService(state, workspaces).create(projectId, { name: 'Docs', branch: 'feature/docs-pass' })
    expect(workspace).toMatchObject({ branch: 'feature/docs-pass', baseRef: 'HEAD', baseCommit: second })
  })

  it('refuses bad input and leaves no branch, folder or record behind', async () => {
    const { dir, repo, state, workspaces, projectId } = setup()
    const service = createWorktreeService(state, workspaces)
    const before = git(repo, 'branch', '--format=%(refname:short)')

    expect(await refusal(service.create(projectId, { name: 'x', base: 'no-such-ref' }))).toEqual({ code: 'invalid-ref', ref: 'no-such-ref' })
    expect(await refusal(service.create(projectId, { name: 'x', base: '--output=/tmp/owned' }))).toMatchObject({ code: 'invalid-ref' })
    expect(await refusal(service.create(projectId, { name: 'x', branch: 'bad..name' }))).toEqual({ code: 'invalid-branch', branch: 'bad..name' })
    expect(await refusal(service.create(projectId, { name: 'x', branch: '-b' }))).toMatchObject({ code: 'invalid-branch' })
    expect(await refusal(service.create(projectId, { name: 'x', branch: 'main' }))).toEqual({ code: 'branch-exists', branch: 'main', checkedOutAt: repo })
    expect(await refusal(service.create(projectId, { name: '   ' }))).toEqual({ code: 'invalid-name' })

    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe(before)
    expect(worktreeCount(repo)).toBe(1)
    expect(workspaces.forProject(projectId)).toHaveLength(1)
    expect(existsSync(join(state, 'worktree-operations'))).toBe(false)
    expect(existsSync(join(dir, 'tmp', 'owned'))).toBe(false)
  })

  it('refuses a second worktree with the same name and shows the first', async () => {
    const { state, workspaces, projectId } = setup()
    const service = createWorktreeService(state, workspaces)
    const first = await service.create(projectId, { name: 'Spike' })
    expect(await refusal(service.create(projectId, { name: 'Spike', branch: 'codex/spike-2' }))).toEqual({ code: 'name-taken', workspaceId: first.id })
  })

  it('names the prerequisite for an unborn repository, a folder outside Git and a merge in progress', async () => {
    const unborn = setup({ commits: false })
    expect(await refusal(createWorktreeService(unborn.state, unborn.workspaces).create(unborn.projectId, { name: 'x' }))).toEqual({ code: 'unborn' })

    const { dir, state, workspaces } = setup()
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    workspaces.ensure([plain])
    const plainId = workspaces.primaryFor(plain)!.project.id
    expect(await refusal(createWorktreeService(state, workspaces).create(plainId, { name: 'x' }))).toEqual({ code: 'not-git' })

    const merging = setup()
    writeFileSync(join(merging.repo, '.git', 'MERGE_HEAD'), `${merging.second}\n`)
    expect(await refusal(createWorktreeService(merging.state, merging.workspaces).create(merging.projectId, { name: 'x' }))).toEqual({ code: 'operation-in-progress', operation: 'merge' })
    expect(await refusal(createWorktreeService(merging.state, merging.workspaces).create('00000000-0000-4000-8000-000000000000', { name: 'x' }))).toEqual({ code: 'unknown-project' })
  })

  it('finds a create that stopped before registration and registers it once (W12-06)', async () => {
    const { repo, state, workspaces, projectId, first } = setup()
    const crashing = createWorktreeService(state, workspaces, { beforeRegister: () => { throw new Error('Cockpit quit') } })
    await expect(crashing.create(projectId, { name: 'Recovery', base: first })).rejects.toThrow('Cockpit quit')
    expect(workspaces.forProject(projectId)).toHaveLength(1)
    expect(worktreeCount(repo)).toBe(2)

    // A restart: a new service over the same state folder.
    const service = createWorktreeService(state, workspaces)
    const [pending] = await service.pending(projectId)
    expect(pending).toMatchObject({ name: 'Recovery', branch: 'codex/recovery', state: 'recoverable' })

    const recovered = await service.recover(pending!.id)
    expect(recovered).toMatchObject({ kind: 'worktree', branch: 'codex/recovery', baseCommit: first, cwd: pending!.path })
    expect(await service.recover(pending!.id)).toEqual(recovered)
    expect(workspaces.forProject(projectId)).toHaveLength(2)
    expect(worktreeCount(repo)).toBe(2)
    expect(await service.pending(projectId)).toEqual([])
  })

  it('reports a changed worktree instead of registering it, and dismiss leaves Git as it is', async () => {
    const { repo, state, workspaces, projectId } = setup()
    const crashing = createWorktreeService(state, workspaces, { beforeRegister: () => { throw new Error('Cockpit quit') } })
    await expect(crashing.create(projectId, { name: 'Moved on' })).rejects.toThrow()
    const service = createWorktreeService(state, workspaces)
    const [pending] = await service.pending(projectId)
    writeFileSync(join(pending!.path, 'new.txt'), 'work\n')
    git(pending!.path, 'add', '.')
    git(pending!.path, 'commit', '-q', '-m', 'work after the crash')

    const [changed] = await service.pending(projectId)
    expect(changed).toMatchObject({ state: 'mismatch' })
    expect(await refusal(service.recover(pending!.id))).toMatchObject({ code: 'not-recoverable' })

    expect(service.dismiss(pending!.id)).toMatchObject({ state: 'dismissed' })
    expect(await service.pending(projectId)).toEqual([])
    expect(readFileSync(join(pending!.path, 'new.txt'), 'utf8')).toBe('work\n')
    expect(git(repo, 'rev-parse', '--verify', 'codex/moved-on')).toMatch(/^[0-9a-f]{40}$/)
    expect(await refusal(service.recover('not-an-id'))).toEqual({ code: 'unknown-operation' })
  })

  it('parses Git\'s worktree list and makes branch names from names', () => {
    expect(parseWorktreeList('worktree /a\0HEAD abc\0branch refs/heads/main\0\0worktree /b c\0HEAD def\0detached\0\0')).toEqual([
      { path: '/a', head: 'abc', branch: 'main' }, { path: '/b c', head: 'def' },
    ])
    expect(branchSlug('Try a recovery path!')).toBe('try-a-recovery-path')
    expect(branchSlug('***')).toBe('worktree')
  })
})
