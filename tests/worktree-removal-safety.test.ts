import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWorkspaceStore } from '../server/projects/workspaces.ts'
import { createWorktreeService } from '../server/projects/worktrees.ts'
import { createWorktreeLifecycle } from '../server/projects/worktree-lifecycle.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('refuses removal when ignored-file status exceeds the Git output limit, preserving the files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-removal-security-')))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' }
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '*.ignored\n.env\n')
  git('add', '.gitignore'); git('commit', '-qm', 'fixture')
  const state = join(root, 'state'); mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const project = workspaces.primaryFor(repo)!.project
  const workspace = await createWorktreeService(state, workspaces).create(project.id, { name: 'Safety' })
  const lifecycle = createWorktreeLifecycle({ workspaces, activeIn: () => [] })
  const clean = await lifecycle.removalCheck(workspace.id)
  expect(clean.removable).toBe(true)
  const sentinel = join(workspace.cwd, '.env')
  writeFileSync(sentinel, 'SYNTHETIC_ONLY=keep-me\n')
  // Root-level ignored entries cannot be collapsed into one ignored directory by Git.
  for (let i = 0; i < 9500; i++) writeFileSync(join(workspace.cwd, `${String(i).padStart(5, '0')}-${'x'.repeat(210)}.ignored`), '')
  const full = await lifecycle.removalCheck(workspace.id)
  const result = await lifecycle.remove(workspace.id, clean.fingerprint).then(() => 'removed', () => 'refused')
  expect(result).toBe('refused')
  expect(full.removable).toBe(false)
  expect(full.blockers.some((s) => s.includes('status'))).toBe(true)
  expect(existsSync(workspace.cwd)).toBe(true)
  expect(readFileSync(sentinel, 'utf8')).toBe('SYNTHETIC_ONLY=keep-me\n')
}, 30_000)
