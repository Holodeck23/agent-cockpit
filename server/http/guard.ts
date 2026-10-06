import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

// This server can start agents that edit files. A browser tab on any website
// can reach 127.0.0.1, so every API request must prove it comes from the
// cockpit's own page:
//   - Host must be a loopback name (defeats DNS rebinding)
//   - Origin, when present, must match that host (defeats CSRF)
//   - writes must be application/json (forces a CORS preflight we never answer)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function isTrustedRequest(req: IncomingMessage, allowedPorts: readonly number[]): boolean {
  const host = req.headers.host ?? ''
  const [hostname, portText] = host.startsWith('[') ? [host.slice(0, host.indexOf(']') + 1), host.split(']:')[1]] : host.split(':')
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) return false
  if (!allowedPorts.includes(Number(portText))) return false

  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const url = new URL(origin)
      if (!LOOPBACK_HOSTS.has(url.hostname) || !allowedPorts.includes(Number(url.port))) return false
    } catch {
      return false
    }
  }

  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) return false
  }
  return true
}

// The checks above stop web pages, not other programs on the Mac: any local process can send
// any Host, Origin and Content-Type. The desktop app closes that gap with a key made at each
// launch. Its main process adds the key to requests from the Cockpit window only (see
// electron/window-key.ts), so the page itself never sees it and an agent's shell cannot send it.
export const WINDOW_KEY_HEADER = 'x-cockpit-window'

// A WebKit shell cannot add headers on the way out (and EventSource cannot send them at all), so
// there the key travels as an HttpOnly cookie instead, set once by window-entry.ts. The page's
// script still never sees it. Same key, same check; the header wins when both are present.
export const WINDOW_KEY_COOKIE = 'cockpit_window'

export function hasWindowKey(req: IncomingMessage, key: string): boolean {
  const header = req.headers[WINDOW_KEY_HEADER]
  const sent = typeof header === 'string' ? header : cookieValue(req.headers.cookie, WINDOW_KEY_COOKIE)
  return sent !== undefined && sameSecret(sent, key)
}

export function sameSecret(sent: string, expected: string): boolean {
  const a = Buffer.from(sent)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}
