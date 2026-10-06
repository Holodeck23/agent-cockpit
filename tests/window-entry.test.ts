import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createWindowEntry, ENTRY_PATH } from '../server/http/window-entry.ts'
import { WINDOW_KEY_COOKIE } from '../server/http/guard.ts'

const key = 'k'.repeat(64)
const token = 't'.repeat(64)
const ports = () => [4317]

function req(path: string, headers: Record<string, string> = { host: '127.0.0.1:4317' }, method = 'GET'): IncomingMessage {
  return { url: path, method, headers } as unknown as IncomingMessage
}
function res() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' }
  const response = {
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return response },
    end(body?: string) { out.body = body ?? '' },
  }
  return { out, response: response as unknown as ServerResponse }
}

describe('window entry', () => {
  it('ignores every other path', () => {
    const entry = createWindowEntry(key, token, ports)
    expect(entry(req('/'), res().response)).toBe(false)
    expect(entry(req('/api/threads'), res().response)).toBe(false)
  })

  it('sets the key as an HttpOnly, SameSite=Strict session cookie once, then refuses', () => {
    const entry = createWindowEntry(key, token, ports)
    const first = res()
    expect(entry(req(`${ENTRY_PATH}?t=${token}`), first.response)).toBe(true)
    expect(first.out.status).toBe(302)
    expect(first.out.headers.location).toBe('/')
    const cookie = first.out.headers['set-cookie']!
    expect(cookie).toContain(`${WINDOW_KEY_COOKIE}=${key}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toMatch(/Max-Age|Expires/i)

    const second = res()
    expect(entry(req(`${ENTRY_PATH}?t=${token}`), second.response)).toBe(true)
    expect(second.out.status).toBe(403)
    expect(second.out.headers['set-cookie']).toBeUndefined()
  })

  it('refuses a wrong token without spending the real one', () => {
    const entry = createWindowEntry(key, token, ports)
    const wrong = res()
    entry(req(`${ENTRY_PATH}?t=${'x'.repeat(64)}`), wrong.response)
    expect(wrong.out.status).toBe(403)
    const right = res()
    entry(req(`${ENTRY_PATH}?t=${token}`), right.response)
    expect(right.out.status).toBe(302)
  })

  it('refuses a non-loopback host or a foreign origin', () => {
    const entry = createWindowEntry(key, token, ports)
    const rebound = res()
    entry(req(`${ENTRY_PATH}?t=${token}`, { host: 'evil.example:4317' }), rebound.response)
    expect(rebound.out.status).toBe(403)
    const foreign = res()
    entry(req(`${ENTRY_PATH}?t=${token}`, { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:5173' }), foreign.response)
    expect(foreign.out.status).toBe(403)
  })
})
