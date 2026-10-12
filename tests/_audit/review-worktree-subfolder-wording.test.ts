import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeRefusal } from '../../server/http/workspace-routes.ts'
import { createWorkspaceStore } from '../../server/projects/workspaces.ts'
import { WorktreeRefusalError, createWorktreeService, type WorktreeRefusal } from '../../server/projects/worktrees.ts'

// Review of u12-4: a project that is a subfolder of a repository is refused a worktree with the
// 'not-git' code, which reads "This folder is not a Git repository" for a folder Cockpit itself
// shows as a Git project. It needs its own code and words that say how to go on.

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

const refusalOf = async (attempt: () => Promise<unknown>): Promise<WorktreeRefusal | undefined> => {
  try { await attempt(); return undefined } catch (error) {
    if (error instanceof WorktreeRefusalError) return error.refusal
    throw error
  }
}

describe('review: a worktree refused for a project inside a repository says so', () => {
  it('preflight and create refuse a subfolder with a code that names the repository top, not "not a Git repository"', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-review-wt-')))
    const repo = join(dir, 'monorepo')
    const app = join(repo, 'packages-app')
    mkdirSync(app, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(app, 'index.ts'), 'export {}\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first')
    const state = join(dir, 'state'); mkdirSync(state)
    const workspaces = createWorkspaceStore(state)
    workspaces.ensure([repo, app])
    const service = createWorktreeService(state, workspaces)
    const projectId = workspaces.primaryFor(app)!.project.id

    for (const attempt of [() => service.preflight(projectId), () => service.create(projectId, { name: 'Nested' })]) {
      const refusal = await refusalOf(attempt)
      expect(refusal).toEqual({ code: 'not-repository-top', top: repo })
      const words = describeRefusal(refusal!)
      expect(words).not.toContain('not a Git repository')
      expect(words).toContain(repo)
      expect(words).toMatch(/open that top folder as the project/)
    }
  })

  it('control: a folder that is not in any repository is still "not a Git repository"', () => {
    expect(describeRefusal({ code: 'not-git' })).toBe('This folder is not a Git repository. Worktrees need Git.')
  })
})
