// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ReplyContext, ReplyMarkdown } from '../../web/src/markdown/reply.tsx'

// u30-2: '[`1a2b3c4`](https://github.com/o/r/commit/1a2b3c4)' renders a <button> (the commit/file
// override of the code span) inside the <a>. One click ran the button's handler and then bubbled to
// the anchor, which opened the same page in the browser pane as well.
// CORRECT behaviour: inside an external link a code span is plain code, so a click does exactly one thing.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

function clickFirst(text: string, selector: string): string[] {
  const calls: string[] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const value = {
    projectPath: '/work/app',
    onOpenFile: (t: { path: string }) => { calls.push(`file:${t.path}`) },
    onOpenCommit: (hash: string) => { calls.push(`commit:${hash}`); return Promise.resolve('opened' as const) },
    onOpenWeb: (url: string) => { calls.push(`web:${url}`) },
  }
  act(() => { root!.render(createElement(ReplyContext.Provider, { value }, createElement(ReplyMarkdown, { text }))) })
  const target = host.querySelector(selector)
  if (!target) throw new Error(`nothing matches ${selector} in ${host.innerHTML}`)
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
  return calls
}

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('a code span inside an external link', () => {
  it('a commit hash link opens the page once, not also the commit', () => {
    expect(clickFirst('[`1a2b3c4`](https://github.com/o/r/commit/1a2b3c4)', 'a button, a code')).toEqual(['web:https://github.com/o/r/commit/1a2b3c4'])
  })
  it('a file link opens the browser pane only, not also Files', () => {
    expect(clickFirst('[`src/a.ts`](https://github.com/o/r/blob/main/src/a.ts)', 'a button, a code')).toEqual(['web:https://github.com/o/r/blob/main/src/a.ts'])
  })
  it('is plain code in the link, not a button inside an anchor', () => {
    const calls = clickFirst('[`src/a.ts`](https://github.com/o/r/blob/main/src/a.ts)', 'a button, a code')
    expect(host!.querySelector('a button')).toBeNull()
    expect(calls).toEqual(['web:https://github.com/o/r/blob/main/src/a.ts'])
  })
  it('code outside a link still opens the file or the commit', () => {
    expect(clickFirst('see `src/a.ts:3`', 'button.file-link')).toEqual(['file:src/a.ts'])
    expect(clickFirst('see `1a2b3c4`', 'button.commit-link')).toEqual(['commit:1a2b3c4'])
  })
})
