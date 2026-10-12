// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhonePanel } from '../../web/src/components/PhonePanel.tsx'
import type { RemoteStatus } from '../../web/src/api.ts'

// review of u22-2: the "Turn off phone access" button added for phone access that is on but not running
// shares the panel's one `busy` flag with "Try again", whose label was `busy ? 'Turning on…' : ...`.
// Clicking Turn off made the other button read "Turning on…" while the request turned phone access OFF.
// CORRECT behaviour: while a request is in flight both buttons wait, but only the one that is being
// answered says what is happening.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const down: RemoteStatus = {
  enabled: true, running: false, port: 51234, allowedLogins: ['me@example.com'], devices: [], pairings: [],
  error: 'Tailscale is not running. Open Tailscale and sign in.',
}
const off: RemoteStatus = { enabled: false, running: false, port: 51234, allowedLogins: ['me@example.com'], devices: [], pairings: [] }

let root: Root | undefined
let host: HTMLElement | undefined
let answer: (() => void) | undefined

beforeEach(() => {
  // The server's answer is pending until the test releases it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = () => resolve(new Response(JSON.stringify({ data: off }), { status: 200 })) })))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const labels = (): string[] => [...host!.querySelectorAll<HTMLButtonElement>('.phone-menu button.phone-toggle')].map((b) => b.textContent ?? '')
const button = (label: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)

async function open(status: RemoteStatus): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(PhonePanel, { status, onError: () => undefined, onOpenChange: () => undefined })) })
  act(() => { host!.querySelector<HTMLButtonElement>('button[aria-label="Phone access"]')!.click() })
  await settle()
}

describe('the phone access buttons while a request is in flight', () => {
  it('does not say "Turning on…" while phone access is being turned off', async () => {
    await open(down)
    act(() => { button('Turn off phone access')!.click() })
    expect(labels()).not.toContain('Turning on…')
    expect(button('Try again')).toBeDefined()
    // Both wait for the answer.
    expect(button('Try again')!.disabled).toBe(true)
    expect([...host!.querySelectorAll<HTMLButtonElement>('.phone-toggle.off')].every((b) => b.disabled)).toBe(true)
    await act(async () => { answer?.(); await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(button('Try again')!.disabled).toBe(false)
  })

  it('says what is happening on the button that was pressed', async () => {
    await open(down)
    act(() => { button('Turn off phone access')!.click() })
    expect(labels()).toEqual(['Try again', 'Turning off…'])
  })

  it('still says "Turning on…" while phone access is being turned on (control)', async () => {
    await open(down)
    act(() => { button('Try again')!.click() })
    expect(labels()).toEqual(['Turning on…', 'Turn off phone access'])
    await act(async () => { answer?.(); await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(labels()).toEqual(['Try again', 'Turn off phone access'])
  })

  it('says "Turning on…" for a first turn-on too (control)', async () => {
    await open(off)
    act(() => { button('Turn on phone access')!.click() })
    expect(labels()).toEqual(['Turning on…'])
  })
})
