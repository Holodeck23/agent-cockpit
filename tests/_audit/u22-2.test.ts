// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhonePanel } from '../../web/src/components/PhonePanel.tsx'
import type { RemoteStatus } from '../../web/src/api.ts'

// u22-2: the server keeps `enabled: true` after a successful enable, and at launch resume() tries
// enable() again and swallows a failure, leaving enabled=true, running=false and an error (Tailscale
// quit, logged out or uninstalled). PhonePanel shows "Turn off phone access" only while running, so
// in that state the only button is "Try again", which can only ever try to turn phone access ON.
// CORRECT behaviour: while phone access is enabled but not running, the panel also offers
// "Turn off phone access", which posts {enabled:false} (the server's disable() copes without Tailscale).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const down: RemoteStatus = {
  enabled: true, running: false, port: 51234, allowedLogins: ['me@example.com'], devices: [], pairings: [],
  error: 'Tailscale is not running. Open Tailscale and sign in.',
}
const off: RemoteStatus = { enabled: false, running: false, port: 51234, allowedLogins: ['me@example.com'], devices: [], pairings: [] }

let root: Root | undefined
let host: HTMLElement | undefined
const posts: unknown[] = []

beforeEach(() => {
  posts.length = 0
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: { body?: string }) => {
    posts.push(init?.body === undefined ? undefined : JSON.parse(init.body))
    return new Response(JSON.stringify({ data: off }), { status: 200 })
  }))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const button = (label: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)

async function open(status: RemoteStatus): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(PhonePanel, { status, onError: () => undefined, onOpenChange: () => undefined })) })
  act(() => { host!.querySelector<HTMLButtonElement>('button[aria-label="Phone access"]')!.click() })
  await settle()
}

describe('u22-2: phone access that is on but not running can be turned off', () => {
  it('shows the error and both "Try again" and "Turn off phone access"', async () => {
    await open(down)
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe(down.error)
    expect(button('Try again')).toBeDefined()
    expect(button('Turn off phone access')).toBeDefined()
  })

  it('"Turn off phone access" asks the server to disable it', async () => {
    await open(down)
    act(() => { button('Turn off phone access')!.click() })
    await settle()
    expect(posts).toEqual([{ enabled: false }])
  })

  it('does not offer to turn off what was never turned on', async () => {
    await open(off)
    expect(button('Turn on phone access')).toBeDefined()
    expect(button('Turn off phone access')).toBeUndefined()
  })
})
