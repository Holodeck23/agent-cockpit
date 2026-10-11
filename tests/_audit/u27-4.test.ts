// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairPhone } from '../../web/src/components/PairPhone.tsx'

// u27-4: the pairing screen polls every 2 s and treated ANY failed poll as "The request expired. Ask
// again." and stopped. A dropped connection (screen lock, a network change on the walk to the Mac) or a
// proxy's non-JSON reply made a request that is still good for minutes look expired, and the Mac's
// approval was never redeemed. The server means "expired" only as 404 "This pairing request has expired".
// CORRECT behaviour: a failed poll that is not that 404 is tried again on the next tick.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined
let polls: Array<() => Response | Promise<Response>> = []
let asked = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  polls = []
  asked = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
    const url = String(path)
    if (url === '/api/remote/pair' && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'req1', code: '123-456' } }), { status: 201 })
    if (url === '/api/remote/pair/req1') {
      asked += 1
      const next = polls.shift()
      if (!next) return new Response(JSON.stringify({ data: { status: 'pending' } }), { status: 200 })
      return next()
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
  }))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }) }
const tick = async (): Promise<void> => { await act(async () => { vi.advanceTimersByTime(2000) }); await flush() }

async function waiting(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(PairPhone, { login: 'me@example.com' })) })
  act(() => { host!.querySelector<HTMLButtonElement>('button.pair-ask')!.click() })
  await flush()
  expect(host.textContent).toContain('Waiting for your Mac')
}

describe('u27-4: a failed poll is not an expired request', () => {
  it('a dropped connection is retried and the later approval still lands', async () => {
    await waiting()
    polls = [() => { throw new TypeError('Load failed') }]
    await tick()
    expect(asked).toBe(1)
    expect(host!.textContent).not.toContain('expired')
    expect(host!.textContent).toContain('Waiting for your Mac')

    polls = [() => new Response(JSON.stringify({ data: { status: 'denied' } }), { status: 200 })]
    await tick()
    expect(asked).toBe(2) // still polling after the failure
    expect(host!.textContent).toContain('The Mac denied this request')
  })

  it('a proxy\'s non-JSON reply is retried', async () => {
    await waiting()
    polls = [() => new Response('<html>Bad gateway</html>', { status: 502 })]
    await tick()
    expect(host!.textContent).not.toContain('expired')
    await tick()
    expect(asked).toBe(2)
  })

  it('the Mac saying the request has expired still ends the wait', async () => {
    await waiting()
    polls = [() => new Response(JSON.stringify({ error: 'This pairing request has expired' }), { status: 404 })]
    await tick()
    expect(host!.textContent).toContain('The request expired. Ask again.')
    await tick()
    expect(asked).toBe(1) // polling stopped
  })
})
