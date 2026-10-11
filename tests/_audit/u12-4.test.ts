import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../../server/projects/workspaces.ts'
import { WorktreeRefusalError, createWorktreeService } from '../../server/projects/worktrees.ts'

// u12-4: gitCommonDir() walks up, so a project opened at a SUBFOLDER of a repository counts as a Git
// project. create() then runs `git worktree add` from the subfolder and places the worktree at
// `<subfolder>-worktree-<id>`: a worktree of the whole repository, nested inside the parent repo's
// working tree. It shows up as untracked in the main checkout, and the worktree's root (not the
// equivalent subfolder) becomes the workspace folder, so merge preflight can never come clean.
// Correct behaviour: a worktree is only made for a project whose folder is the repository's top;
// a subfolder is refused and nothing is created inside the repository.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function monorepo() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-u12-4-')))
  const repo = join(dir, 'monorepo')
  const app = join(repo, 'packages-app')
  mkdirSync(app, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(app, 'index.ts'), 'export {}\n')
  writeFileSync(join(repo, 'README.md'), 'root\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo, app])
  return { repo, app, workspaces, service: createWorktreeService(state, workspaces) }
}

const refusalOf = async (attempt: () => Promise<unknown>): Promise<unknown> => {
  try { await attempt(); return undefined } catch (error) {
    if (error instanceof WorktreeRefusalError) return error.refusal
    throw error
  }
}

describe('u12-4: worktrees for a project that is a subfolder of a repository', () => {
  it('control: the repository top still gets a worktree', async () => {
    const { repo, workspaces, service } = monorepo()
    const projectId = workspaces.primaryFor(repo)!.project.id
    expect(await service.preflight(projectId)).toMatchObject({ branch: 'main', uncommitted: 0 })
    expect(await service.create(projectId, { name: 'Top' })).toMatchObject({ kind: 'worktree', lifecycle: 'active' })
  })

  it('refuses to make a worktree for a subfolder, and puts nothing inside the repository', async () => {
    const { repo, app, workspaces, service } = monorepo()
    const projectId = workspaces.primaryFor(app)!.project.id
    expect(await refusalOf(() => service.preflight(projectId))).toBeDefined()
    expect(await refusalOf(() => service.create(projectId, { name: 'Nested' }))).toBeDefined()
    expect(readdirSync(repo).filter((name) => name.includes('-worktree-'))).toEqual([])
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'worktree', 'list')).not.toContain('-worktree-')
  })
})
