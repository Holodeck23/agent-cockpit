// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewWorktreeDialog } from '../../web/src/components/NewWorktreeDialog.tsx'
import { branchSlug } from '../../server/projects/worktrees.ts'

// u29-2: the dialog's Branch placeholder and its "Leave empty for ..." hint come from
// branchSuggestion, which falls back to the literal "<name>" for a name with no [a-z0-9]
// characters (Cyrillic, CJK, emoji). The server's branchSlug falls back to "worktree", so the
// dialog promised codex/<name> and the server created codex/worktree.
// CORRECT behaviour: once a name is typed the suggestion is the branch the server will create;
// "<name>" stays only as the placeholder while the name field is empty.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { head: 'abcdef1234567', branch: 'main', uncommitted: 0, branchPrefix: 'codex/' } }), { status: 200 })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(NewWorktreeDialog, { projectId: 'p1', projectName: 'Garden', onCreate: async () => undefined, onClose: () => undefined })) })
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const typeName = (value: string): void => {
  const input = host!.querySelector<HTMLInputElement>('input[aria-label="Worktree name"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const placeholder = (): string => host!.querySelector<HTMLInputElement>('input[aria-label="Branch"]')!.placeholder
const hint = (): string => [...host!.querySelectorAll('small')].map((s) => s.textContent ?? '').find((t) => t.startsWith('A new branch')) ?? ''

describe('u29-2: the branch the dialog promises is the branch the server creates', () => {
  it.each(['Привет', '日本語', '🚀!!'])('%s: suggests the server fallback, not <name>', async (typed) => {
    await settle()
    typeName(typed)
    const server = `codex/${branchSlug(typed)}`
    expect(server).toBe('codex/worktree')
    expect(placeholder()).toBe(server)
    expect(hint()).toContain(`Leave empty for ${server}.`)
  })

  it('a Latin name still previews its slug, and the empty field keeps the <name> placeholder', async () => {
    await settle()
    expect(placeholder()).toBe('codex/<name>')
    typeName('Checkout redesign!')
    expect(placeholder()).toBe('codex/checkout-redesign')
    expect(placeholder()).toBe(`codex/${branchSlug('Checkout redesign!')}`)
  })
})
