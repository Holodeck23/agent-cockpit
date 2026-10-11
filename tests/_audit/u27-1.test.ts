// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MergeBack } from '../../web/src/components/MergeBack.tsx'

// u27-1: a merge that stopped on conflicts shows only Show in Files / Continue / Abort. The panel tells
// you to resolve the files in the main checkout, which is exactly when someone runs `git commit` or
// `git merge --abort` in a terminal. Continue and Abort then refuse ("The main checkout is no longer in
// this merge"), and the panel has no Check again, so it can only be left by closing the dialog.
// (The server half, a recorded conflict the repository no longer shows being closed on the next look, is
// reconcile() in server/projects/merge.ts, already in place.)
// CORRECT behaviour: the conflict panel can look again; once the repository no longer shows the merge,
// the panel is the ordinary "Merge with Git" one.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const UNSAFE = 'The main checkout is no longer in this merge. Check it in a terminal (git status) before doing anything else.'
const operation = {
  id: '11111111-1111-4111-8111-111111111111', sourceWorkspaceId: 'wt1', targetWorkspaceId: 'main', sourceBranch: 'feature', targetBranch: 'main',
  sourceHead: 'a'.repeat(40), targetHeadBefore: 'b'.repeat(40), mode: 'merge', stage: 'conflict', conflicts: ['src/a.ts'],
}
const preview = (open: boolean) => ({
  sourceWorkspaceId: 'wt1', targetWorkspaceId: 'main', sourceBranch: 'feature', sourceHead: 'a'.repeat(40), targetBranch: 'main', targetHead: 'c'.repeat(40),
  mode: 'merge', commits: 1, files: [{ status: 'M', path: 'src/a.ts' }], blockers: open ? ['A merge of this worktree is waiting: continue or abort it first.'] : [],
  fingerprint: 'fp', ...(open ? { open: operation } : {}),
})

let root: Root | undefined
let host: HTMLElement | undefined
let previews = 0

beforeEach(() => {
  previews = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
    const url = String(path)
    if (url.endsWith('/merge') && (init?.method ?? 'GET') === 'GET') {
      previews += 1
      // The first look finds the recorded conflict; by the second, the user has finished the merge in a terminal.
      return new Response(JSON.stringify({ data: preview(previews === 1) }), { status: 200 })
    }
    if (url.endsWith('/continue') || url.endsWith('/abort')) return new Response(JSON.stringify({ error: UNSAFE }), { status: 409 })
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

describe('u27-1: the conflict panel can be left once the merge was finished outside Cockpit', () => {
  it('offers Check again, which returns to the ordinary merge panel', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(createElement(MergeBack, { workspaceId: 'wt1', onDone: () => undefined })) })

    await click('Merge into the main checkout…')
    expect(host.textContent).toContain('The merge stopped on conflicts in 1 file')

    await click('Continue')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(UNSAFE)
    await click('Abort merge')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(UNSAFE)

    // The panel is still the conflict one, and it must have a way to look again.
    expect(button('Check again')).toBeDefined()
    await click('Check again')
    expect(previews).toBe(2)
    expect(host.textContent).not.toContain('The merge stopped on conflicts')
    expect(button('Merge with Git')).toBeDefined()
  })
})
