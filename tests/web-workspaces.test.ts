import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../server/threads/types.ts'
import type { Workspace } from '../server/projects/workspaces.ts'
import {
  activityIn, branchSuggestion, createSelectionGuard, folderOf, labelOf, nativeFolder, phoneWorkspaceId, processIn, resolveSelection, scopedKey,
  sendTarget, threadsIn, workspacesOf,
} from '../web/src/workspaces.ts'

const PRIMARY = '00000000-0000-4000-8000-000000000001'
const WT = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'
const project = { path: '/work/garden', workspaceId: PRIMARY }

const worktree = (patch: Partial<Workspace> = {}): Workspace => ({
  id: WT, projectId: '00000000-0000-4000-8000-0000000000aa', kind: 'worktree', cwd: '/work/garden-worktree-ab12cd', canonicalCwd: '/work/garden-worktree-ab12cd',
  gitCommonDir: '/work/garden/.git', managed: true, lifecycle: 'active', revision: 1, createdAt: '2026-10-07T10:00:00.000Z',
  name: 'Roses', branch: 'codex/roses', ...patch,
})

function thread(id: string, meta: { workspaceId?: string; bindings?: string[] } = {}, status: ThreadSummary['status'] = 'done'): ThreadSummary {
  return {
    meta: {
      id, title: id, projectPath: project.path, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
      sessionId: id, sessionStarted: true, completed: false, createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z',
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta.bindings ? { bindings: Object.fromEntries(meta.bindings.map((b) => [b, { agent: 'claude', bindingId: b, sessionId: b, sessionStarted: true, cursor: 0 }])) } : {}),
    },
    status, preview: '', messageCount: 1, lastActivityAt: '2026-10-07T10:00:00.000Z',
  } as ThreadSummary
}

describe('the selected workspace, resolved', () => {
  it('is the main checkout with nothing saved or the primary saved', () => {
    expect(resolveSelection(project, [], undefined)).toMatchObject({ kind: 'primary', id: PRIMARY, folder: '/work/garden', scope: undefined })
    expect(resolveSelection(project, [worktree()], PRIMARY).kind).toBe('primary')
  })

  it('finds an active worktree and scopes requests to it', () => {
    expect(resolveSelection(project, [worktree()], WT)).toMatchObject({ kind: 'worktree', id: WT, label: 'Roses', scope: WT, folder: '/work/garden-worktree-ab12cd' })
  })

  it('never falls back to the main checkout when the choice is gone', () => {
    const gone = resolveSelection(project, [], WT)
    expect(gone).toMatchObject({ kind: 'missing', id: WT, label: 'Missing workspace', folder: '/work/garden', scope: WT })
    expect(resolveSelection(project, [worktree({ lifecycle: 'removed' })], WT)).toMatchObject({ kind: 'missing', label: 'Roses (missing)' })
  })

  it('waits for the list before judging a saved worktree', () => {
    expect(resolveSelection(project, undefined, WT).kind).toBe('loading')
    expect(resolveSelection(project, undefined, undefined).kind).toBe('primary')
  })

  it('keys the main checkout exactly as before and a worktree apart', () => {
    expect(scopedKey('/work/garden', resolveSelection(project, [], undefined))).toBe('/work/garden')
    expect(scopedKey('/work/garden', resolveSelection(project, [worktree()], WT))).toBe(`/work/garden@${WT}`)
  })
})

describe('where a send goes', () => {
  const main = resolveSelection(project, [], undefined)
  const wt = resolveSelection(project, [worktree()], WT)

  it('stays implicit while the project has no worktree', () => {
    expect(sendTarget(main, false)).toEqual({ ok: true })
  })
  it('names the workspace once the project has a worktree, main checkout included', () => {
    expect(sendTarget(main, true)).toEqual({ ok: true, workspaceId: PRIMARY })
    expect(sendTarget(wt, true)).toEqual({ ok: true, workspaceId: WT })
  })
  it('names it for a conversation that has run in two workspaces even with no worktree left', () => {
    expect(sendTarget(main, false, thread('a', { bindings: [WT] }).meta)).toEqual({ ok: true, workspaceId: PRIMARY })
  })
  it('refuses a missing or loading workspace instead of sending to the main checkout', () => {
    const gone = sendTarget(resolveSelection(project, [], WT), true)
    expect(gone.ok).toBe(false)
    expect(sendTarget(resolveSelection(project, undefined, WT), true).ok).toBe(false)
  })
  it('lets the phone name the conversation own workspace only once it has more than one', () => {
    expect(phoneWorkspaceId(thread('a', { workspaceId: WT }).meta)).toBeUndefined()
    expect(phoneWorkspaceId(thread('a', { workspaceId: WT, bindings: [PRIMARY] }).meta)).toBe(WT)
  })
})

describe('which conversations ran where', () => {
  const inMain = thread('main-only')
  const inWt = thread('wt-only', { workspaceId: WT })
  const both = thread('both', { workspaceId: PRIMARY, bindings: [WT] })
  const all = [inMain, inWt, both]

  it('lists a conversation under each workspace it has a session in', () => {
    expect(workspacesOf(both.meta, PRIMARY).sort()).toEqual([PRIMARY, WT].sort())
    expect(threadsIn(all, WT, PRIMARY).map((t) => t.meta.id)).toEqual(['wt-only', 'both'])
    expect(threadsIn(all, PRIMARY, PRIMARY).map((t) => t.meta.id)).toEqual(['main-only', 'both'])
  })
  it('treats a conversation with no workspace as the primary one', () => {
    expect(threadsIn([inMain], PRIMARY, PRIMARY)).toHaveLength(1)
    expect(threadsIn([inMain], WT, PRIMARY)).toHaveLength(0)
  })
  it('counts running work only where the conversation works now', () => {
    const rows = [thread('a', { workspaceId: WT }, 'working'), thread('b', { workspaceId: PRIMARY, bindings: [WT] }, 'working'), thread('c', { workspaceId: WT }, 'needs_input')]
    expect(activityIn(rows, WT, PRIMARY)).toEqual({ working: 1, needsYou: 1 })
    expect(activityIn(rows, PRIMARY, PRIMARY)).toEqual({ working: 1, needsYou: 0 })
  })
})

describe('processes, folders and labels', () => {
  const wt = resolveSelection(project, [worktree()], WT)
  const main = resolveSelection(project, [], undefined)
  it('puts a process in the workspace it was started in, else by its folder', () => {
    expect(processIn({ cwd: '/work/garden-worktree-ab12cd', workspaceId: WT }, wt)).toBe(true)
    expect(processIn({ cwd: '/work/garden', workspaceId: PRIMARY }, wt)).toBe(false)
    expect(processIn({ cwd: '/work/garden/web' }, main)).toBe(true)
    expect(processIn({ cwd: '/work/garden-worktree-ab12cd' }, main)).toBe(false)
  })
  it('uses the worktree folder for a worktree and the project folder otherwise', () => {
    expect(folderOf([worktree()], project, WT)).toBe('/work/garden-worktree-ab12cd')
    expect(folderOf([worktree({ lifecycle: 'removed' })], project, WT)).toBe('/work/garden')
    expect(folderOf([worktree()], project, undefined)).toBe('/work/garden')
  })
  it('acts on a worktree folder for its project files but on the project for its documents', () => {
    expect(nativeFolder('/work/garden', 'project', { scope: WT, folder: '/work/garden-worktree-ab12cd' })).toBe('/work/garden-worktree-ab12cd')
    expect(nativeFolder('/work/garden', 'documents', { scope: WT, folder: '/work/garden-worktree-ab12cd' })).toBe('/work/garden')
    expect(nativeFolder('/work/garden', 'project', { folder: '/work/garden' })).toBe('/work/garden')
  })
  it('names workspaces', () => {
    expect(labelOf([worktree()], project, undefined)).toBe('Main checkout')
    expect(labelOf([worktree()], project, WT)).toBe('Roses')
    expect(labelOf([worktree()], project, OTHER)).toBe('Missing workspace')
  })
  it('suggests the default branch like the server does', () => {
    expect(branchSuggestion('codex/', 'Checkout redesign!')).toBe('codex/checkout-redesign')
    expect(branchSuggestion('codex/', '')).toBe('codex/<name>')
  })
})

describe('stale answers', () => {
  it('lets an answer through while the view is the one that asked', () => {
    const guard = createSelectionGuard()
    guard.sync('garden|A')
    const stillCurrent = guard.begin()
    guard.sync('garden|A')
    expect(stillCurrent()).toBe(true)
  })
  it('drops an answer for a workspace that is no longer selected, even if it returns later', () => {
    const guard = createSelectionGuard()
    guard.sync('garden|A')
    const forA = guard.begin()
    guard.sync('garden|B')
    const forB = guard.begin()
    expect(forA()).toBe(false)
    expect(forB()).toBe(true)
    // Going back to A is a new view: the old request still must not land.
    guard.sync('garden|A')
    expect(forA()).toBe(false)
    expect(forB()).toBe(false)
  })
})
