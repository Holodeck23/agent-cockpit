import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isTrustedRequest } from '../server/http/guard.ts'

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
