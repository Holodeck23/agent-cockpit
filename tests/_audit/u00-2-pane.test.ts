// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPane } from '../../web/src/components/BrowserPane.tsx'

// u00-2 (page half): the pane's OK on "Reloaded: Cockpit unloaded this page" must tell the main
// process through the bridge (browser.reloadSeen), or the notice returns on every remount.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'thread:t1'
const h = vi.hoisted(() => ({ reloadSeen: undefined as undefined | ReturnType<typeof import('vitest').vi.fn> }))

vi.mock('../../web/src/native.ts', () => {
  const reloadSeen = vi.fn()
  h.reloadSeen = reloadSeen
  const page = { key: 'thread:t1', url: 'https://example.com/a', title: 'Example', canGoBack: false, canGoForward: false, loading: false, reloaded: true }
  return {
    native: {
      browser: {
        open: vi.fn(() => Promise.resolve(page)), place: vi.fn(), navigate: vi.fn(), state: vi.fn(() => Promise.resolve(page)),
        openExternal: vi.fn(), close: vi.fn(), clearData: vi.fn(() => Promise.resolve(undefined)), onState: vi.fn(() => () => {}), reloadSeen,
      },
    },
  }
})

let root: Root | undefined
let host: HTMLDivElement | undefined
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.unstubAllGlobals() })

describe('u00-2: the Reloaded notice', () => {
  it('tells the main process when OK is pressed, and hides the notice at once', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const layout = { url: 'https://example.com/a', mode: 'desktop' as const, width: 480, expanded: false, visible: true }
    await act(async () => { root!.render(createElement(BrowserPane, { pageKey: KEY, projectPath: '/Users/example/garden', layout, openNonce: 0, onLayout: vi.fn(), onClose: vi.fn() })) })
    const ok = [...host.querySelectorAll('button')].find((b) => b.textContent === 'OK')!
    expect(ok).toBeTruthy()
    expect(h.reloadSeen).not.toHaveBeenCalled()
    await act(async () => { ok.click() })
    expect(h.reloadSeen).toHaveBeenCalledWith(KEY)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'OK')).toBe(false)
  })
})
