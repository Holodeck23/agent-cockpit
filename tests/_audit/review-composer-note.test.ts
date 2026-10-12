// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../../web/src/components/Composer.tsx'
import type { MessageImage } from '../../web/src/api.ts'

// review of u25: submit() takes the sent chips out one by one (attach.remove) so an image pasted while
// sending stays. attach.clear() was the only post-send path that also dropped the drop/paste notice
// ("x was left out...", "y is over 5 MB"), so the notice about what was dropped before the send stayed on
// screen after the message had gone.
// CORRECT behaviour: the notice that was showing when the message left goes with it; a notice a newer
// drop made while it was sending stays, like the image would.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

let draft = 0

function mount(onSubmit: (text: string, images: readonly MessageImage[]) => Promise<void>): { box: HTMLTextAreaElement; notice: () => string | undefined } {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const key = `review-composer-note-${draft++}` // chips are held per draft key for the module's life; keep the tests apart
  act(() => {
    root!.render(createElement(Composer, { draftKey: key, placeholder: 'Message', picker: null, onSubmit }))
  })
  return {
    box: host.querySelector('textarea')!,
    notice: () => host!.querySelector('p.workflow-notice[role="status"]')?.textContent ?? undefined,
  }
}

// A pasted file that is no image and is no file on disk: "only images can be added here", named in a notice.
function pasteFile(box: HTMLTextAreaElement, name: string): void {
  const file = new File(['x'], name, { type: 'text/plain' })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [file], types: ['Files'], getData: () => '' } })
  act(() => { box.dispatchEvent(event) })
}

function type(box: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => { setter.call(box, value); box.dispatchEvent(new Event('input', { bubbles: true })) })
}

const send = (box: HTMLTextAreaElement): void => { act(() => { box.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) }) }

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('the drop notice after a send', () => {
  it('goes with the message it was about', async () => {
    const { box, notice } = mount(async () => undefined)
    pasteFile(box, 'notes.txt')
    expect(notice()).toContain('notes.txt')
    type(box, 'here you go')
    send(box)
    await settle()
    expect(notice()).toBeUndefined()
  })

  it('stays when the send fails, with the draft (control)', async () => {
    const { box, notice } = mount(async () => { throw new Error('offline') })
    pasteFile(box, 'notes.txt')
    type(box, 'here you go')
    send(box)
    await settle()
    expect(notice()).toContain('notes.txt')
  })

  it('is replaced, not cleared, by a newer drop made while the message was sending', async () => {
    let release: (() => void) | undefined
    const { box, notice } = mount(() => new Promise<void>((resolve) => { release = resolve }))
    pasteFile(box, 'first.txt')
    type(box, 'here you go')
    send(box)
    pasteFile(box, 'second.txt')
    expect(notice()).toContain('second.txt')
    await act(async () => { release?.(); await new Promise((r) => setTimeout(r, 50)) })
    expect(notice()).toContain('second.txt')
  })
})
