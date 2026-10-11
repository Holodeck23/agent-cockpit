// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://mac.tail.ts.net:8443/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// u21-1: the same bundle runs in the Mac's window and on a paired phone, and only a successful
// /api/remote/me says which. A rejection (a dropped link, a 5xx, the 400 for two device cookies) used to
// be read as "this is the Mac", so the phone mounted the desktop app. The page now only falls back to
// the desktop app where it can tell it is on the Mac; on a phone it retries and then says what went wrong.

const hoisted = vi.hoisted(() => ({ pageMode: vi.fn() }))

vi.mock('../../web/src/api.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../web/src/api.ts')>()), api: { pageMode: hoisted.pageMode } }))
vi.mock('../../web/src/App.tsx', async () => {
  const { createElement } = await import('react')
  return { App: ({ page }: { page: { mode: string } }) => createElement('div', { 'data-testid': 'app' }, `app:${page.mode}`) }
})
vi.mock('../../web/src/components/BetaTerms.tsx', async () => {
  const { createElement, Fragment } = await import('react')
  return { BetaTermsGate: ({ children }: { children: unknown }) => createElement(Fragment, null, children as never) }
})
vi.mock('../../web/src/components/PairPhone.tsx', async () => {
  const { createElement } = await import('react')
  return { PairPhone: () => createElement('div', { 'data-testid': 'pair' }, 'pair') }
})
vi.mock('../../web/src/window-chrome.ts', () => ({ trackWindowChrome: () => undefined }))

const { ApiError } = await import('../../web/src/api.ts')
const root = (): string => document.getElementById('root')?.textContent ?? ''
const boot = async (): Promise<void> => { await import('../../web/src/main.tsx') }

describe('u21-1: a failed look-up of where the page runs', () => {
  beforeEach(() => {
    vi.resetModules()
    hoisted.pageMode.mockReset()
    document.body.innerHTML = '<div id="root"></div>'
    document.documentElement.className = ''
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as { cockpit?: unknown }).cockpit
  })

  it('does not show the desktop app on a phone when the server refuses', async () => {
    hoisted.pageMode.mockRejectedValue(new ApiError("This browser sent two Cockpit sign-ins. Clear this site's data in the browser, then pair the phone again.", 400))
    await boot()
    await vi.waitFor(() => expect(root()).toContain('two Cockpit sign-ins'), { timeout: 10_000 })
    expect(root()).not.toContain('app:')
    expect(root()).toContain('Try again')
    // A refusal is not asked for again.
    expect(hoisted.pageMode).toHaveBeenCalledTimes(1)
  })

  it('asks again after a dropped link, then shows the phone app', async () => {
    hoisted.pageMode.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ mode: 'remote', login: 'me@example.com', paired: true, notifications: false })
    await boot()
    await vi.waitFor(() => expect(root()).toContain('app:remote'), { timeout: 10_000 })
    expect(document.documentElement.classList.contains('phone')).toBe(true)
    expect(hoisted.pageMode).toHaveBeenCalledTimes(2)
  })

  it('says the Mac did not answer when the link stays down, instead of showing the desktop app', async () => {
    hoisted.pageMode.mockRejectedValue(new TypeError('Failed to fetch'))
    await boot()
    await vi.waitFor(() => expect(root()).toContain('Your Mac did not answer'), { timeout: 10_000 })
    expect(root()).not.toContain('app:')
    expect(hoisted.pageMode).toHaveBeenCalledTimes(3)
  })

  it('still opens the desktop app inside the Mac window, where nothing else could be meant', async () => {
    ;(window as { cockpit?: unknown }).cockpit = { platform: 'darwin' }
    hoisted.pageMode.mockRejectedValue(new TypeError('Failed to fetch'))
    await boot()
    await vi.waitFor(() => expect(root()).toContain('app:local'), { timeout: 10_000 })
    expect(hoisted.pageMode).toHaveBeenCalledTimes(1)
  })

  it('opens the desktop app when the server says it is the Mac', async () => {
    hoisted.pageMode.mockResolvedValue({ mode: 'local' })
    await boot()
    await vi.waitFor(() => expect(root()).toContain('app:local'), { timeout: 10_000 })
  })
})
