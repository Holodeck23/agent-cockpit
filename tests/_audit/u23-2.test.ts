// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorFindBar, type FindAdapter } from '../../web/src/components/EditorFindBar.tsx'
import { findIn, replaceAllIn } from '../../web/src/editor-find.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// u23-2: Replace did not move on. The edit re-ran the search, which clamps `current` to the same
// index, so a replacement that still contains the query (a longer word, or only a change of case)
// put the next Replace on the text just written ("user" -> "userId" -> "userIdId"), and the other
// matches were never reached.

describe('replace one steps on to the next match', () => {
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

  /** A little editor: the text lives here, Replace edits it, and the bar is told through contentKey. */
  async function open(initial: string): Promise<{ text: () => string; replaceButton: () => HTMLButtonElement; find: (q: string, replacement: string) => Promise<void>; replaceOnce: () => Promise<void> }> {
    let text = initial
    let matches: Array<[number, number]> = []
    let setText: (value: string) => void = () => undefined
    const adapter: FindAdapter = {
      search: (query, matchCase) => { matches = findIn(text, query, matchCase); return matches.length },
      paint: () => undefined,
      reveal: () => undefined,
      replace: (index, replacement) => {
        const at = matches[index]
        if (!at) return
        text = replaceAllIn(text, [at], replacement)
        setText(text)
      },
      replaceAll: () => 0,
      clear: () => undefined,
    }
    function Editor() {
      const [shown, set] = useState(initial)
      setText = set
      return createElement(EditorFindBar, { adapter, contentKey: shown, withReplace: true, readOnly: false, onClose: () => undefined })
    }
    await act(async () => root.render(createElement(Editor)))
    const replaceButton = (): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Replace')!
    return {
      text: () => text,
      replaceButton,
      find: async (q, replacement) => {
        await type(host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!, q)
        await type(host.querySelector<HTMLInputElement>('input[aria-label="Replace with"]')!, replacement)
      },
      replaceOnce: async () => { await act(async () => { replaceButton().click() }) },
    }
  }

  it('a longer replacement that contains the query is applied once per match', async () => {
    const editor = await open('user, user and user')
    await editor.find('user', 'userId')
    await editor.replaceOnce()
    await editor.replaceOnce()
    await editor.replaceOnce()
    expect(editor.text()).toBe('userId, userId and userId')
  })

  it('a change of case alone moves through the matches', async () => {
    const editor = await open('api and api and api')
    await editor.find('api', 'API')
    await editor.replaceOnce()
    await editor.replaceOnce()
    await editor.replaceOnce()
    expect(editor.text()).toBe('API and API and API')
  })

  it('a replacement without the query still takes the matches in order', async () => {
    const editor = await open('user, user and user')
    await editor.find('user', 'x')
    await editor.replaceOnce()
    expect(editor.text()).toBe('x, user and user')
    await editor.replaceOnce()
    await editor.replaceOnce()
    expect(editor.text()).toBe('x, x and x')
    expect(host.querySelector('.find-count')!.textContent).toBe('No matches')
  })

  it('the count reads from the match after the replaced one', async () => {
    const editor = await open('user, user and user')
    await editor.find('user', 'userId')
    await editor.replaceOnce()
    expect(host.querySelector('.find-count')!.textContent).toBe('2 of 3')
  })
})
