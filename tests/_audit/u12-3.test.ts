import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../../server/projects/workspaces.ts'
import { WorktreeRefusalError, createWorktreeService } from '../../server/projects/worktrees.ts'

// u12-3: ensure() skips any folder it already knows and gitCommonDir is only computed when the primary
// record is first created. A folder opened before `git init` is registered with gitCommonDir null and
// worktrees.ts repoOf() then refuses 'not-git' forever, even though the folder is now a repository and
// ensure() runs again on every project listing and thread start.
// Correct behaviour: once the folder is a Git repository with a first commit, the same project can
// preflight and create a worktree without hand-editing workspaces.json.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function folderOpenedBeforeGitInit() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-u12-3-')))
  const repo = join(dir, 'newproject')
  mkdirSync(repo)
  const state = join(dir, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  // The person opens an empty folder as a project: registered while it is not a repository.
  workspaces.ensure([repo])
  const { project, workspace } = workspaces.primaryFor(repo)!
  expect(workspace.gitCommonDir).toBeNull()
  // The agent (or person) then initialises Git and makes the first commit.
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  // Every project listing and thread start calls ensure() again for the same path.
  workspaces.ensure([repo])
  return { repo, state, workspaces, projectId: project.id }
}

describe('u12-3 primary workspace gitCommonDir after git init', () => {
  it('re-ensuring a folder that has since become a repository records its git dir', () => {
    const { repo, workspaces } = folderOpenedBeforeGitInit()
    expect(workspaces.primaryFor(repo)!.workspace.gitCommonDir).toBe(realpathSync(join(repo, '.git')))
  })

  it('preflight and create do not refuse not-git for a folder that is now a repository', async () => {
    const { state, workspaces, projectId } = folderOpenedBeforeGitInit()
    const service = createWorktreeService(state, workspaces)
    const attempt = async (): Promise<unknown> => {
      try { return await service.preflight(projectId) } catch (error) {
        if (error instanceof WorktreeRefusalError) return { refused: error.refusal.code }
        throw error
      }
    }
    expect(await attempt()).not.toEqual({ refused: 'not-git' })
    const created = await service.create(projectId, { name: 'After init' })
    expect(created).toMatchObject({ kind: 'worktree', lifecycle: 'active', name: 'After init' })
  })

  it('a worktree can be made right after git init, before any listing has re-ensured the folder', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-u12-3-')))
    const repo = join(dir, 'fresh')
    mkdirSync(repo)
    const state = join(dir, 'state')
    mkdirSync(state)
    const workspaces = createWorkspaceStore(state)
    workspaces.ensure([repo])
    const projectId = workspaces.primaryFor(repo)!.project.id
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    const created = await createWorktreeService(state, workspaces).create(projectId, { name: 'Straight away' })
    expect(created).toMatchObject({ kind: 'worktree', lifecycle: 'active', name: 'Straight away' })
  })

  it('re-ensuring an unchanged folder writes nothing', () => {
    const { repo, workspaces } = folderOpenedBeforeGitInit()
    const before = workspaces.list().revision
    workspaces.ensure([repo])
    expect(workspaces.list().revision).toBe(before)
  })
})
