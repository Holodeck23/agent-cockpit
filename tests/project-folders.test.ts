import { describe, expect, it } from 'vitest'
import { isKnownFolder } from '../server/projects/folders.ts'
import type { Workspace } from '../server/projects/workspaces.ts'

const ID = '00000000-0000-4000-8000-0000000000aa'
const wt = (cwd: string, patch: Partial<Workspace> = {}): Workspace => ({
  id: crypto.randomUUID(), projectId: ID, kind: 'worktree', cwd, canonicalCwd: cwd, gitCommonDir: null, managed: true, lifecycle: 'active', revision: 1,
  createdAt: '2026-10-07T10:00:00.000Z', name: 'w', branch: 'codex/w', ...patch,
})
const projects = { list: () => [{ path: '/work/garden' }] as ReturnType<import('../server/projects/store.ts').ProjectStore['list']> }
const workspaces = (list: Workspace[]) => ({
  primaryFor: (path: string) => (path === '/work/garden' ? { project: { id: ID, path, canonicalPath: path, createdAt: '' }, workspace: {} as Workspace } : undefined),
  forProject: (id: string) => (id === ID ? list : []),
})

describe('the folders the desktop shell may act on', () => {
  it('accepts an open project folder and its active registered worktrees', () => {
    const w = workspaces([wt('/work/garden-worktree-ab12cd')])
    expect(isKnownFolder(projects, w, '/work/garden')).toBe(true)
    expect(isKnownFolder(projects, w, '/work/garden-worktree-ab12cd')).toBe(true)
  })
  it('refuses a folder nobody registered, a removed worktree, and a lookalike path', () => {
    const w = workspaces([wt('/work/garden-worktree-ab12cd'), wt('/work/garden-worktree-ffffff', { lifecycle: 'removed' })])
    expect(isKnownFolder(projects, w, '/work/garden-worktree-ffffff')).toBe(false)
    expect(isKnownFolder(projects, w, '/work/garden-worktree-ab12cd/..')).toBe(false)
    expect(isKnownFolder(projects, w, '/work/elsewhere')).toBe(false)
    expect(isKnownFolder(projects, w, '/work/garden/../garden-worktree-ab12cd')).toBe(false)
  })
  it('knows no worktrees without a workspace store', () => {
    expect(isKnownFolder(projects, undefined, '/work/garden-worktree-ab12cd')).toBe(false)
  })
})
