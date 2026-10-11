// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FindBar } from '../../web/src/components/FindBar.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// u23-5: the highlight effect scrolled to the current match every time the matches were collected
// again, and they are collected again on every new transcript event (contentKey). While an agent
// was working, the user could not scroll away from the match they had stepped to.

describe('conversation find does not pull the view back when only the content changes', () => {
  let host: HTMLDivElement
  let transcript: HTMLDivElement
  let root: Root
  let scrolls: number
  const proto = Element.prototype as { scrollIntoView?: () => void; getClientRects: () => unknown }
  const saved = { scrollIntoView: proto.scrollIntoView, getClientRects: proto.getClientRects }

  beforeEach(() => {
    scrolls = 0
    // jsdom does no layout and has no scrolling or highlights; these stand in for them.
    proto.scrollIntoView = () => { scrolls += 1 }
    proto.getClientRects = () => [{}]
    vi.stubGlobal('CSS', { highlights: new Map() })
    vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) {} })
    transcript = document.body.appendChild(document.createElement('div'))
    transcript.innerHTML = '<p>error one</p><p>error two</p><p>fine</p>'
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

  const render = (contentKey: string) => act(async () => root.render(createElement(FindBar, { root: { current: transcript }, contentKey, onClose: () => undefined })))
  const type = (value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const enter = () => act(async () => { host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

  it('scrolls for a new query and for stepping, but not for new content', async () => {
    await render('t:1')
    await type('error')
    expect(host.querySelector('.find-count')!.textContent).toBe('1 of 2')
    expect(scrolls).toBe(1)

    await enter()
    expect(host.querySelector('.find-count')!.textContent).toBe('2 of 2')
    expect(scrolls).toBe(2)

    // New events arrive: the matches are collected again, the user is somewhere else.
    await render('t:2')
    await render('t:3')
    expect(host.querySelector('.find-count')!.textContent).toBe('2 of 2')
    expect(scrolls).toBe(2)

    // A new query goes to its match, even at the same position in the list.
    await type('erro')
    expect(host.querySelector('.find-count')!.textContent).toBe('2 of 2')
    expect(scrolls).toBe(3)
  })
})
