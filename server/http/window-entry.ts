import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedRequest, sameSecret, WINDOW_KEY_COOKIE } from './guard.ts'

// How a WebKit window gets the per-launch key (guard.ts) without its script ever holding it.
// The host process hands the shell a one-time entry token over a private pipe; the shell opens
// the window at ENTRY_PATH with it; the server answers once with the key as an HttpOnly cookie
// and sends the window on to the app. A second visit, or a wrong token, gets nothing.

export const ENTRY_PATH = '/__cockpit/enter'

/** Returns a handler that answers ENTRY_PATH (true) and ignores everything else (false). */
export function createWindowEntry(key: string, token: string, allowedPorts: () => readonly number[]) {
  let spent = false
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== ENTRY_PATH) return false
    const offered = url.searchParams.get('t') ?? ''
    if (spent || req.method !== 'GET' || !isTrustedRequest(req, allowedPorts()) || !sameSecret(offered, token)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('This window entry has already been used.')
      return true
    }
    spent = true
    res.writeHead(302, {
      // No Max-Age: a session cookie, gone when the app quits, and the next launch has a new key anyway.
      'set-cookie': `${WINDOW_KEY_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
      'cache-control': 'no-store',
      location: '/',
    })
    res.end()
    return true
  }
}
