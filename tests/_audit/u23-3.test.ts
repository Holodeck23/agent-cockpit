// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FindBar } from '../../web/src/components/FindBar.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// u23-3: findRanges measured offsets in the lower-cased text, which is longer for "İ" (U+0130), and
// FindBar applied them to the original text node. A match near the end made Range.setEnd throw an
// IndexSizeError inside a layout effect, which unmounts the whole app (there is no error boundary);
// a match elsewhere was highlighted a character off. The offsets come from web/src/find.ts.

describe('conversation find over text with a dotted capital I', () => {
  let host: HTMLDivElement
  let transcript: HTMLDivElement
  let root: Root
  let painted: string[]
  const proto = Element.prototype as { scrollIntoView?: () => void; getClientRects: () => unknown }
  const saved = { scrollIntoView: proto.scrollIntoView, getClientRects: proto.getClientRects }

  beforeEach(() => {
    painted = []
    proto.scrollIntoView = () => undefined
    proto.getClientRects = () => [{}]
    vi.stubGlobal('CSS', { highlights: new Map() })
    vi.stubGlobal('Highlight', class { constructor(...ranges: Range[]) { painted = ranges.map((r) => r.toString()) } })
    transcript = document.body.appendChild(document.createElement('div'))
    transcript.innerHTML = '<p>İstanbul trip</p>'
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    transcript.remove()
    proto.scrollIntoView = saved.scrollIntoView
    proto.getClientRects = saved.getClientRects
    vi.unstubAllGlobals()
  })

  const type = (value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  it('highlights the text that was searched for, without throwing', async () => {
    expect('İstanbul trip'.toLowerCase().length).not.toBe('İstanbul trip'.length)
    await act(async () => root.render(createElement(FindBar, { root: { current: transcript }, contentKey: 't:1', onClose: () => undefined })))
    await type('trip')
    expect(host.querySelector('.find-count')!.textContent).toBe('1 of 1')
    expect(painted).toEqual(['trip'])
    await type('stanbul')
    expect(painted).toEqual(['stanbul'])
  })
})
