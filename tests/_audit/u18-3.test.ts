// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useComposerAttach } from '../../web/src/useComposerAttach.ts'

// u18-3: Composer's <textarea onPaste={attach.onPaste}>. onPaste cancels the default paste whenever
// clipboardData.files is non-empty. Excel / Numbers put text/plain + text/html + a rendered image/png
// on the clipboard together, and Chrome/Electron list that PNG in clipboardData.files, so the cell text
// is never pasted and a picture of the cells becomes an image chip instead.
// CORRECT behaviour: a paste that carries text (and whose image is only a rendering of it, with no file
// on disk) stays a normal text paste: the default is not prevented and no image chip appears.
// A paste that is only an image (a screenshot) is still taken over and becomes a chip.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

let draft = 0
function mount(): { box: HTMLTextAreaElement; chips: () => number } {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const key = `u18-3-${draft++}` // chips are held per draft key for the module's life; keep the tests apart
  const Probe = (): ReactElement => {
    const attach = useComposerAttach({ draftKey: key, onInsert: () => undefined })
    return createElement('div', { 'data-chips': String(attach.images.length) },
      createElement('textarea', { onPaste: attach.onPaste }))
  }
  act(() => { root!.render(createElement(Probe)) })
  return {
    box: host.querySelector('textarea')!,
    chips: () => Number(host!.querySelector('div')!.getAttribute('data-chips')),
  }
}

// jsdom has no ClipboardEvent/DataTransfer, so the paste is a plain cancelable event carrying the
// clipboardData shape React reads (files, types, getData).
function paste(box: HTMLTextAreaElement, data: { files: File[]; text: Record<string, string> }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: data.files,
      types: [...Object.keys(data.text), ...(data.files.length ? ['Files'] : [])],
      getData: (type: string) => data.text[type] ?? '',
    },
  })
  act(() => { box.dispatchEvent(event) })
  return event
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) }) }

// 1x1 PNG, the rendering a spreadsheet adds beside its cells.
const png = (): File => new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' })

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('pasting spreadsheet cells into the composer', () => {
  it('keeps the text paste: not cancelled, and no image chip replaces the cell text', async () => {
    const { box, chips } = mount()
    const event = paste(box, {
      files: [png()],
      text: { 'text/plain': 'name\tqty\napple\t3', 'text/html': '<table><tr><td>name</td><td>qty</td></tr><tr><td>apple</td><td>3</td></tr></table>' },
    })
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(chips()).toBe(0)
  })

  it('control: a lone screenshot is still taken over and becomes one image chip', async () => {
    const { box, chips } = mount()
    const event = paste(box, { files: [png()], text: {} })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(chips()).toBe(1)
  })
})
