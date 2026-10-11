// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@milkdown/kit/core'
import { DocumentToolbar } from '../../web/src/components/DocumentToolbar.tsx'

// u27-6: every formatting button ran its action from onMouseDown only. Enter or Space on a focused
// button fires `click`, never `mousedown`, so a keyboard user could focus Bold and nothing happened.
// CORRECT behaviour: the action runs on click (which is what a mouse click and Enter/Space both make),
// and mousedown only keeps the editor's selection (default prevented) without running anything.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

const BUTTONS = ['Bold', 'Italic', 'Inline code', 'Bullet list', 'Numbered list', 'To-do', 'Quote', 'Code block']

function mount(): ReturnType<typeof vi.fn> {
  const action = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(DocumentToolbar, { editor: { action } as unknown as Editor })) })
  return action
}
const button = (label: string): HTMLButtonElement => host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

describe('u27-6: the formatting toolbar works from the keyboard', () => {
  it.each(BUTTONS)('%s runs on click, the event Enter and Space make', (label) => {
    const action = mount()
    act(() => { button(label).click() }) // a keyboard activation is a click with no mousedown before it
    expect(action).toHaveBeenCalled()
  })

  it.each(BUTTONS)('%s keeps the editor\'s selection on mousedown without running yet', (label) => {
    const action = mount()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => { button(label).dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    expect(action).not.toHaveBeenCalled()
  })

  it('a mouse click (mousedown then click) runs the action once', () => {
    const action = mount()
    act(() => {
      button('Bold').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      button('Bold').click()
    })
    // One command and one refocus: two editor.action calls, not four.
    expect(action).toHaveBeenCalledTimes(2)
  })
})
