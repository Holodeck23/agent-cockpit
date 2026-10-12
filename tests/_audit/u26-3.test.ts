// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { FileEditor } from '../../web/src/components/FileEditor.tsx'
import { openFile, type OpenFile } from '../../web/src/file-text.ts'

// u26-3: clicking the x on a tab with unsaved changes shows "<name> has unsaved changes. Discard
// changes / Keep editing". Only its own two buttons cleared it, so Save or Revert (the file is now
// clean) left a banner claiming unsaved changes, and it came back when the file was edited again.
// CORRECT behaviour: the question goes away when the file stops being dirty.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const clean = openFile('a.txt', 'saved text\n', 'v1')
const edited: OpenFile = { ...clean, draft: 'edited text\n' }
let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

const noop = (): void => undefined
const show = (files: readonly OpenFile[]): void => {
  act(() => {
    root!.render(createElement(FileEditor, {
      files, active: 'a.txt', error: '', onSelect: noop, onClose: noop, onCloseMany: () => 0, onChange: noop, onSave: noop, onReload: noop,
      onOverwrite: noop, onSaveCopy: noop, onAttach: noop, explorer: { hidden: false, toggle: noop },
    }))
  })
}
const banner = (): boolean => (host!.textContent ?? '').includes('has unsaved changes.')

describe('u26-3: the close confirmation goes away once the file is clean', () => {
  it('drops the banner after a save or revert, and does not bring it back on the next edit', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    show([edited])
    expect(banner()).toBe(false)
    act(() => { (host!.querySelector('.file-tab-close') as HTMLButtonElement).click() })
    expect(banner()).toBe(true) // asked, because the file has unsaved changes
    show([clean]) // Save (or Revert) made it clean
    expect(banner()).toBe(false)
    show([edited]) // edited again later
    expect(banner()).toBe(false)
  })

  it('still asks while the file stays dirty, and Keep editing dismisses it', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    show([edited])
    act(() => { (host!.querySelector('.file-tab-close') as HTMLButtonElement).click() })
    show([{ ...edited, draft: 'edited more\n' }])
    expect(banner()).toBe(true)
    act(() => { [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Keep editing')!.click() })
    expect(banner()).toBe(false)
  })
})
