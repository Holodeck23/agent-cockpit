// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../../web/src/components/Composer.tsx'
import type { MessageImage } from '../../web/src/api.ts'

// u25-1: Composer.submit() sends the image chips it held when Send was pressed, then (after the await)
// called attach.clear(sentFrom), which empties EVERY chip held for that draft. An image pasted while the
// POST was still pending was never sent, yet its chip vanished with the sent ones; text typed in the same
// window is kept (draftAfterSend).
// CORRECT behaviour: only the chips that went leave; an image added while sending stays for the next message.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

let draft = 0
interface Sent { text: string; images: readonly MessageImage[] }

function mount(): { box: HTMLTextAreaElement; chips: () => string[]; sent: Sent[]; release: () => Promise<void> } {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const sent: Sent[] = []
  let resolveSend: (() => void) | undefined
  // The server round-trip: pending until the test releases it.
  const onSubmit = (text: string, images: readonly MessageImage[]): Promise<void> => {
    sent.push({ text, images })
    return new Promise<void>((resolve) => { resolveSend = resolve })
  }
  const key = `u25-1-${draft++}` // chips are held per draft key for the module's life; keep the tests apart
  act(() => {
    root!.render(createElement(Composer, { draftKey: key, placeholder: 'Message', picker: null, onSubmit }))
  })
  return {
    box: host.querySelector('textarea')!,
    chips: () => Array.from(host!.querySelectorAll('.image-chip span')).map((s) => s.textContent ?? ''),
    sent,
    release: async () => { await act(async () => { resolveSend?.(); await new Promise((r) => setTimeout(r, 50)) }) },
  }
}

// jsdom has no ClipboardEvent/DataTransfer, so the paste is a plain cancelable event carrying the
// clipboardData shape React reads (files, types, getData).
function paste(box: HTMLTextAreaElement, file: File): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [file], types: ['Files'], getData: () => '' },
  })
  act(() => { box.dispatchEvent(event) })
}

function type(box: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => { setter.call(box, value); box.dispatchEvent(new Event('input', { bubbles: true })) })
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) }) }

// 1x1 PNG, named so the chips can be told apart.
const png = (name: string): File => new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('sending with an image while another is added', () => {
  it('keeps the image added while the message was sending', async () => {
    const { box, chips, sent, release } = mount()
    paste(box, png('a.png'))
    await settle()
    expect(chips()).toEqual(['a.png'])

    type(box, 'look at this')
    act(() => { box.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.images.map((i) => i.name)).toEqual(['a.png'])

    // The POST is still pending: a second screenshot is pasted.
    paste(box, png('b.png'))
    await settle()
    expect(chips()).toEqual(['a.png', 'b.png'])

    await release()
    // b.png was never sent: it must still be there for the next message; a.png went and is gone.
    expect(chips()).toEqual(['b.png'])
  })

  it('control: with nothing added meanwhile, the sent image leaves', async () => {
    const { box, chips, sent, release } = mount()
    paste(box, png('a.png'))
    await settle()
    type(box, 'look at this')
    act(() => { box.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(sent).toHaveLength(1)
    await release()
    expect(chips()).toEqual([])
  })
})
