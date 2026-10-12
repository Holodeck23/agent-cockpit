// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManageWorktreesDialog } from '../../web/src/components/ManageWorktreesDialog.tsx'
import type { Project, Workspace } from '../../web/src/api.ts'
import type { Workspaces } from '../../web/src/useWorkspaces.ts'

// u22-1: Manage worktrees keeps the removal check it got until the next SUCCESS. When the check said
// "removable" the row offers only "Remove with Git"; the server then refuses a remove whose
// fingerprint no longer matches (code "stale": "The worktree changed after it was checked. Check it
// again.") but the row still holds the old check and has no button that checks again.
// CORRECT behaviour: after a refused removal the row shows the refusal and offers "Remove…" (a fresh
// check) again, instead of the outdated "nothing unique" message and a button that can only fail.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STALE = 'The worktree changed after it was checked. Check it again.'
const project = { name: 'demo', path: '/proj', workspaceId: 'main' } as unknown as Project
const worktree = { id: 'wt1', kind: 'worktree', lifecycle: 'active', name: 'feature', branch: 'feature', cwd: '/proj-wt' } as unknown as Workspace
const check = (fingerprint: string) => ({
  workspaceId: 'wt1', path: '/proj-wt', branch: 'feature', blockers: [], unique: { changed: 0, untracked: 0, ignored: 0, commits: 0 }, removable: true, fingerprint,
})

let root: Root | undefined
let host: HTMLElement | undefined
let checks = 0

beforeEach(() => {
  checks = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (String(path).endsWith('/removal')) return new Response(JSON.stringify({ data: check(`fp${++checks}`) }), { status: 200 })
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
  }))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const button = (label: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)
const click = async (label: string): Promise<void> => { act(() => { button(label)!.click() }); await settle() }

describe('u22-1: a refused removal can be checked again', () => {
  it('after a stale refusal the row offers a fresh check, not only "Remove with Git"', async () => {
    const removed: string[] = []
    const workspaces = {
      worktrees: [worktree], archived: [], health: {}, list: [worktree], pending: [], hasWorktrees: true,
      refresh: async () => undefined,
      change: async (_id: string, action: unknown) => {
        const fingerprint = (action as { remove: string }).remove
        removed.push(fingerprint)
        if (fingerprint === 'fp1') throw new Error(STALE) // the worktree changed after the first check
        return worktree
      },
    } as unknown as Workspaces
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(createElement(ManageWorktreesDialog, { project, workspaces, threads: [], onClose: () => undefined })) })
    await settle()

    await click('Remove…')
    expect(host.textContent).toContain('Nothing here is only in this worktree')
    expect(button('Remove with Git')).toBeDefined()

    await click('Remove with Git')
    expect(removed).toEqual(['fp1'])
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(STALE)
    // The old "nothing unique" verdict is gone and a new check can be asked for.
    expect(host.textContent).not.toContain('Nothing here is only in this worktree')
    expect(button('Remove…')).toBeDefined()

    await click('Remove…')
    expect(checks).toBe(2)
    await click('Remove with Git')
    expect(removed).toEqual(['fp1', 'fp2'])
  })
})
