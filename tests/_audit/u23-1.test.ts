// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorFindBar, type FindAdapter } from '../../web/src/components/EditorFindBar.tsx'
import { findIn } from '../../web/src/editor-find.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// u23-1: the paint/reveal effect only depended on [current, count, contentKey]. A new query that
// finds the same number of matches (and keeps the same index) repainted nothing: the highlight
// stayed on the previous query's sites, and the editor did not scroll to the new match.

const TEXT = 'foo bar foo bar'

describe('editor find bar repaints when the query changes but the count does not', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => { host = document.body.appendChild(document.createElement('div')); root = createRoot(host) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  const type = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('paints and reveals the new query\'s matches', async () => {
    let matches: Array<[number, number]> = []
    let painted: Array<[number, number]> = []
    let revealed: [number, number] | undefined
    const adapter: FindAdapter = {
      search: (query, matchCase) => { matches = findIn(TEXT, query, matchCase); return matches.length },
      paint: () => { painted = [...matches] },
      reveal: (index) => { revealed = matches[index] },
      replace: () => undefined,
      replaceAll: () => 0,
      clear: () => undefined,
    }
    await act(async () => root.render(createElement(EditorFindBar, { adapter, contentKey: TEXT, withReplace: false, readOnly: false, onClose: () => undefined })))
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!

    await type(input, 'foo')
    expect(painted).toEqual([[0, 3], [8, 11]])
    expect(revealed).toEqual([0, 3])

    // Same count (2), same current index (0): the matches are different sites.
    await type(input, 'bar')
    expect(host.querySelector('.find-count')!.textContent).toBe('1 of 2')
    expect(painted).toEqual([[4, 7], [12, 15]])
    expect(revealed).toEqual([4, 7])
  })
})
