// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountChoice } from '../../web/src/components/AccountChoice.tsx'

// u24-3: Add an account runs the CLI's sign-in on the server (10 minutes at most) and the form holds
// the only reference to it. Leaving the form (picking another account in the box, the picker or
// settings panel closing) never cancels it, so the server keeps the sign-in open and refuses the
// next one for that agent ("A Claude sign-in is already open") with nothing in the UI to cancel.
// CORRECT behaviour: abandoning an open sign-in cancels it; a finished one is left alone.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const account = (id: string, mode: 'default' | 'managed', label: string) => ({ id, agent: 'claude', label, mode, isolation: 'env', generation: 1, usageKey: `${id}#1` })
const open = { id: 's1', agent: 'claude', label: 'Work', state: 'waiting_for_user', url: 'https://claude.ai/login/x', takesCode: true, lines: [], startedAt: '2026-10-10T10:00:00Z' }
const verified = { ...open, state: 'verified', endedAt: '2026-10-10T10:01:00Z', message: 'Signed in.', account: account('acc-work', 'managed', 'Work') }

let root: Root | undefined
let host: HTMLElement | undefined
let calls: string[] = []
let signinNow: Record<string, unknown> = open

const reply = (data: unknown): Response => new Response(JSON.stringify({ data }), { status: 200 })

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  signinNow = open
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string }) => {
    const call = `${init?.method ?? 'GET'} ${path}`
    calls.push(call)
    if (path.startsWith('/api/accounts/signins/s1/cancel')) return reply({ cancelled: true })
    if (path.startsWith('/api/accounts/signins/s1')) return reply(signinNow)
    if (path.startsWith('/api/accounts') && init?.method === 'POST') return reply(open)
    if (path.startsWith('/api/accounts')) {
      return reply({ accounts: [account('default-claude', 'default', 'CLI default'), account('acc-work', 'managed', 'Work')], support: { claude: { profiles: true, takesCode: true } } })
    }
    if (path === '/api/projects') return reply([{ path: '/tmp/p', projectId: 'pid' }])
    if (path.startsWith('/api/projects/pid/accounts/claude')) return reply({ selection: { claude: 'acc-work' } })
    if (path.startsWith('/api/projects/pid/accounts')) return reply({ selection: { claude: 'default-claude' } })
    return new Response(JSON.stringify({ error: `unexpected ${call}` }), { status: 500 })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(AccountChoice, { agent: 'claude', projectPath: '/tmp/p' })) })
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = async (ms = 0): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const select = (): HTMLSelectElement => host!.querySelector('select[aria-label="Account"]') as HTMLSelectElement
const button = (label: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)
const cancels = (): string[] => calls.filter((c) => c.startsWith('POST /api/accounts/signins/s1/cancel'))

function choose(value: string): void {
  act(() => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Add an account… > name it > Sign in, until the sign-in link shows. */
async function startSignin(): Promise<void> {
  await settle()
  choose('__add')
  const input = host!.querySelector('input[aria-label="Account name"]') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Work')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => { button('Sign in')!.click() })
  await settle()
  expect(host!.textContent).toContain('https://claude.ai/login/x')
  expect(cancels()).toEqual([])
}

describe('u24-3: leaving the Add account form cancels an open sign-in', () => {
  it('picking another account in the box cancels it', async () => {
    await startSignin()
    choose('default-claude')
    await settle()
    expect(host!.textContent).not.toContain('https://claude.ai/login/x')
    expect(cancels()).toHaveLength(1)
  })

  it('the picker or panel closing (unmount) cancels it', async () => {
    await startSignin()
    act(() => { root!.unmount() })
    await settle()
    expect(cancels()).toHaveLength(1)
    root = undefined
  })

  it('a finished sign-in is not cancelled when the form goes away', async () => {
    await startSignin()
    signinNow = verified
    await settle(800)
    await settle()
    expect(host!.textContent).not.toContain('https://claude.ai/login/x')
    act(() => { root!.unmount() })
    await settle()
    expect(cancels()).toEqual([])
    root = undefined
  })

  it('leaving the form before Sign in was pressed cancels nothing', async () => {
    await settle()
    choose('__add')
    choose('default-claude')
    await settle()
    expect(calls.filter((c) => c.includes('/cancel'))).toEqual([])
  })
})
