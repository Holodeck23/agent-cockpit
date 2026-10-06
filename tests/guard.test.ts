import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { hasWindowKey, isTrustedRequest, WINDOW_KEY_COOKIE, WINDOW_KEY_HEADER } from '../server/http/guard.ts'

function req(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}
const ports = [4317]

describe('isTrustedRequest', () => {
  it('accepts the cockpit page talking to itself', () => {
    expect(isTrustedRequest(req('GET', { host: '127.0.0.1:4317' }), ports)).toBe(true)
    expect(
      isTrustedRequest(
        req('POST', { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }),
        ports,
      ),
    ).toBe(true)
  })

  it('rejects DNS-rebinding hosts', () => {
    expect(isTrustedRequest(req('GET', { host: 'evil.example:4317' }), ports)).toBe(false)
  })

  it('rejects cross-site origins', () => {
    const headers = { host: '127.0.0.1:4317', origin: 'https://evil.example', 'content-type': 'application/json' }
    expect(isTrustedRequest(req('POST', headers), ports)).toBe(false)
  })

  it('rejects form-style posts that skip the CORS preflight', () => {
    expect(isTrustedRequest(req('POST', { host: '127.0.0.1:4317', 'content-type': 'text/plain' }), ports)).toBe(false)
  })
})

describe('hasWindowKey', () => {
  const key = 'k'.repeat(64)
  it('accepts the exact key', () => {
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: key }), key)).toBe(true)
  })
  it('refuses a missing, wrong, shorter or longer key', () => {
    expect(hasWindowKey(req('GET', {}), key)).toBe(false)
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: 'j'.repeat(64) }), key)).toBe(false)
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: key.slice(1) }), key)).toBe(false)
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: `${key}k` }), key)).toBe(false)
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: '' }), key)).toBe(false)
  })
})

describe('window key as a cookie (WebKit shell)', () => {
  const key = 'c'.repeat(64)
  it('accepts the key from the cockpit_window cookie among others', () => {
    expect(hasWindowKey(req('GET', { cookie: `theme=dark; ${WINDOW_KEY_COOKIE}=${key}; x=1` }), key)).toBe(true)
  })
  it('refuses a wrong or missing cookie, and a lookalike name', () => {
    expect(hasWindowKey(req('GET', { cookie: `${WINDOW_KEY_COOKIE}=${'d'.repeat(64)}` }), key)).toBe(false)
    expect(hasWindowKey(req('GET', { cookie: `not_${WINDOW_KEY_COOKIE}=${key}` }), key)).toBe(false)
    expect(hasWindowKey(req('GET', {}), key)).toBe(false)
  })
  it('lets a present header decide, so a cookie cannot rescue a wrong header', () => {
    expect(hasWindowKey(req('GET', { [WINDOW_KEY_HEADER]: 'wrong', cookie: `${WINDOW_KEY_COOKIE}=${key}` }), key)).toBe(false)
  })
})
