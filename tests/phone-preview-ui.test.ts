// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { OUTCOME_TITLE, postTicket, requestTicket } from '../web/src/phone-preview.ts'

// View app on the phone (14d): each answer from the control origin becomes its own state, and the
// ticket travels only in a form body to the app's own origin, in a tab of its own.

const reply = (status: number, body: unknown): typeof fetch => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const ticket = { origin: 'https://mac.ts.net:8443', ticket: 'T0k3n', bootstrap: 'https://mac.ts.net:8443/__cockpit/bootstrap', target: 'preview-0' }

describe('asking for a preview ticket', () => {
  it('returns the ticket on success, posted as JSON to the control origin', async () => {
    const fetcher = reply(201, { data: ticket })
    expect(await requestTicket('p1', fetcher)).toEqual(ticket)
    expect(fetcher).toHaveBeenCalledWith('/api/phone/preview-tickets', expect.objectContaining({ method: 'POST', body: JSON.stringify({ processId: 'p1' }) }))
  })
  it.each([
    ['stopped', 409, { state: 'stopped', error: 'not running' }],
    ['not-enabled', 409, { state: 'not-enabled', error: 'turn it on' }],
    ['phone-off', 409, { state: 'phone-off', error: 'off' }],
    ['no-local-url', 409, { state: 'no-local-url', error: 'no address' }],
    ['revoked', 401, { error: 'Pair this phone with Cockpit on your Mac first' }],
    ['failed', 500, { error: 'boom' }],
  ] as const)('maps %s to its own state', async (kind, status, body) => {
    const outcome = await requestTicket('p1', reply(status, body))
    expect(outcome).toMatchObject({ kind })
    expect(OUTCOME_TITLE[kind]).toBeTruthy()
  })
  it('treats an unreachable Mac as disconnected, never as an error thrown at the page', async () => {
    const outcome = await requestTicket('p1', vi.fn(async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch)
    expect(outcome).toMatchObject({ kind: 'disconnected' })
  })
  it('gives every state a distinct title', () => {
    const titles = Object.values(OUTCOME_TITLE)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('posting the ticket', () => {
  it('submits a hidden POST form to the bootstrap in the app\'s own tab, then removes it', () => {
    let seen: HTMLFormElement | undefined
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { seen = this })
    postTicket(ticket)
    expect(submit).toHaveBeenCalledOnce()
    expect(seen?.method).toBe('post')
    expect(seen?.action).toBe(ticket.bootstrap)
    expect(seen?.action).not.toContain('T0k3n')
    expect(seen?.target).toBe('preview-0')
    // Not noreferrer: Chrome would send Origin: null and the bootstrap would refuse the ticket.
    expect(seen?.getAttribute('rel')).toBe('noopener')
    expect(new FormData(seen!).get('ticket')).toBe('T0k3n')
    expect(document.querySelector('form')).toBeNull()
    submit.mockRestore()
  })
})
