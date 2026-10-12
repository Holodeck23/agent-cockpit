// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMenu } from '../../web/src/components/ThreadMenu.tsx'

// u24-2: ThreadMenu clears its "confirming" flag only when ITS setter closes the popover. usePopover
// also closes the menu itself on Escape and on a click outside, without going through that setter,
// so "Delete this conversation?" stays armed and is the first thing the next open shows.
// CORRECT behaviour: a menu dismissed by Escape or an outside click reopens as the normal menu.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(ThreadMenu, {
      transcriptPath: '/tmp/t.jsonl', usage: undefined, completed: false, onToggleCompleted: () => undefined, onDelete: async () => undefined,
    }))
  })
}
const more = (): HTMLButtonElement => host!.querySelector('button[aria-label="More"]') as HTMLButtonElement
const item = (text: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

function openDeleteConfirm(): void {
  act(() => { more().click() })
  act(() => { item('Delete conversation')!.click() })
  expect(host!.querySelector('[role="alertdialog"]')).not.toBeNull()
}

describe('u24-2: a dismissed delete confirmation is not armed for the next open', () => {
  it('Escape, then reopen: the normal menu, not "Delete this conversation?"', () => {
    mount()
    openDeleteConfirm()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    act(() => { more().click() })
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host!.querySelector('[role="menu"]')).not.toBeNull()
    expect(item('Mark as complete')).toBeDefined()
  })

  it('a click outside, then reopen: the normal menu', () => {
    mount()
    openDeleteConfirm()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    act(() => { more().click() })
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host!.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('Cancel then close and reopen still shows the normal menu', () => {
    mount()
    openDeleteConfirm()
    act(() => { item('Cancel')!.click() })
    expect(host!.querySelector('[role="menu"]')).not.toBeNull()
    act(() => { more().click() })
    act(() => { more().click() })
    expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host!.querySelector('[role="menu"]')).not.toBeNull()
  })
})
