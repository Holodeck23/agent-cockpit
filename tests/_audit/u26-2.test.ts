// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditor, type Jump } from '../../web/src/components/FileEditor.tsx'
import { openFile } from '../../web/src/file-text.ts'

// u26-2: Files keeps the reply "jump" in state until the next reveal. FileEditor handed it to the
// Source view whenever it named the open file, and SourceText applies a jump when it MOUNTS, so
// every return to the tab (and every Document -> Source toggle) selected the old lines again,
// pulled focus into the textarea, and forced a Markdown file back to Source.
// CORRECT behaviour: a jump applies once; coming back to the tab leaves focus, selection and the
// chosen view alone, while a NEW jump (new nonce) still applies.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The rich editor is not under test; it renders nothing here.
vi.mock('../../web/src/components/DocumentView.tsx', () => ({ default: () => null }))

const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
const files = ['a.md', 'b.md', 'a.txt', 'b.txt'].map((path) => openFile(path, body, 'v1'))
let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  localStorage.clear()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const noop = (): void => undefined
const mount = async (): Promise<void> => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
}
const show = async (active: string, jump?: Jump): Promise<void> => {
  act(() => {
    root!.render(createElement(FileEditor, {
      files, active, error: '', onSelect: noop, onClose: noop, onCloseMany: () => 0, onChange: noop, onSave: noop, onReload: noop,
      onOverwrite: noop, onSaveCopy: noop, onAttach: noop, jump, explorer: { hidden: false, toggle: noop },
    }))
  })
  await settle()
}
const area = (): HTMLTextAreaElement | null => host!.querySelector('textarea.file-text')
const pressed = (label: string): string | null => [...host!.querySelectorAll('.file-views button')].find((b) => b.textContent === label)?.getAttribute('aria-pressed') ?? null

describe('u26-2: a reply jump applies once', () => {
  it('does not re-select the old lines or take focus when returning to the tab', async () => {
    await mount()
    const jump: Jump = { path: 'a.txt', line: 3, nonce: 1 }
    await show('a.txt', jump)
    expect(document.activeElement).toBe(area()) // the jump itself still works
    expect(area()!.value.slice(area()!.selectionStart, area()!.selectionEnd)).toBe('line 3')
    await show('b.txt', jump)
    await show('a.txt', jump)
    expect(document.activeElement).not.toBe(area())
    expect(area()!.selectionStart).toBe(area()!.selectionEnd)
  })

  it('does not force Source again on a Markdown file the reader switched to Document', async () => {
    await mount()
    const jump: Jump = { path: 'a.md', line: 3, nonce: 1 }
    await show('a.md', jump)
    expect(pressed('Source')).toBe('true') // a jump into Markdown shows Source
    act(() => { [...host!.querySelectorAll('.file-views button')].find((b) => b.textContent === 'Document')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(pressed('Document')).toBe('true')
    await show('b.md', jump)
    await show('a.md', jump)
    expect(pressed('Document')).toBe('true')
    expect(area()).toBeNull()
  })

  it('still applies a new jump (new nonce) to the same file', async () => {
    await mount()
    await show('a.txt', { path: 'a.txt', line: 3, nonce: 1 })
    await show('b.txt', { path: 'a.txt', line: 3, nonce: 1 })
    await show('a.txt', { path: 'a.txt', line: 5, nonce: 2 })
    expect(document.activeElement).toBe(area())
    expect(area()!.value.slice(area()!.selectionStart, area()!.selectionEnd)).toBe('line 5')
  })
})
