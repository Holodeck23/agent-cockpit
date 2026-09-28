import type { IncomingMessage } from 'node:http'

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
