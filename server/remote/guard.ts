import type { IncomingMessage } from 'node:http'
import { isPhoneRoute } from './routes.ts'

// The phone listener is only reachable through `tailscale serve`, which proxies
// https://<mac>.<tailnet>.ts.net to 127.0.0.1:<port>. Serve passes the original
// Host through, sets X-Forwarded-Proto: https, and replaces any client-sent
// Tailscale-User-* headers with the tailnet identity of the requester (tagged
// devices and Funnel traffic get none). So every request must show:
//   - the loopback socket (serve connects locally; the port is bound to 127.0.0.1)
//   - Host equal to this Mac's tailnet name, over HTTPS
//   - a Tailscale login on the allowlist
//   - Origin, when present, equal to https://<tailnet name> (defeats CSRF)
//   - application/json on writes (forces a preflight nobody answers)
// A local process can forge these headers by calling the port directly. That still
// does not reach the API: every API call also needs a paired phone's device token
// (service.ts), which is kept only as a hash on the Mac, and pairing a new phone needs
// a click in the Cockpit window (the desktop API is locked to it, guard.ts in http/).

export interface RemotePolicy {
  /** This Mac's tailnet name, e.g. mac.tailnet.ts.net (no trailing dot). */
  readonly hostname: string
  readonly allowedLogins: readonly string[]
  /** HTTPS port Tailscale serves on; 443 unless configured. */
  readonly httpsPort?: number
}

export type RemoteCheck =
  | { readonly ok: true; readonly login: string }
  | { readonly ok: false; readonly status: 403; readonly error: string }

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const refuse = (error: string): RemoteCheck => ({ ok: false, status: 403, error })

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** host, or host:port when Tailscale serves on a port other than 443. */
export function remoteAuthority({ hostname, httpsPort = 443 }: RemotePolicy): string {
  return httpsPort === 443 ? hostname : `${hostname}:${httpsPort}`
}

export function checkRemote(req: IncomingMessage, policy: RemotePolicy): RemoteCheck {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return refuse('Phone access only works through Tailscale')
  const authority = remoteAuthority(policy)
  const host = (header(req, 'host') ?? '').toLowerCase().replace(/:443$/, '')
  if (!policy.hostname || host !== authority.toLowerCase()) return refuse('Open Cockpit at its Tailscale address')
  if (header(req, 'x-forwarded-proto') !== 'https') return refuse('Phone access requires HTTPS through Tailscale')
  const login = header(req, 'tailscale-user-login')
  if (!login) return refuse('No Tailscale identity on this request')
  if (!policy.allowedLogins.some((allowed) => allowed.toLowerCase() === login.toLowerCase())) {
    return refuse('This Tailscale account is not allowed to use Cockpit')
  }
  const origin = header(req, 'origin')
  if (origin !== undefined && origin !== `https://${authority}`) return refuse('Request came from another site')
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD' && !(header(req, 'content-type') ?? '').startsWith('application/json')) {
    return refuse('Request came from another site')
  }
  return { ok: true, login }
}

/** API routes the phone may use (routes.ts holds the list, allowed or not). */
export function isRemoteRoute(method: string, pathname: string): boolean {
  return isPhoneRoute(method, pathname)
}

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  return cookieValues(req, name)[0]
}

/**
 * Every value sent under a cookie name. Cookies are not isolated by port, so a phone-preview origin
 * on the same host can set one with the same name on another path (SEC-04): callers that
 * authenticate with a cookie treat more than one value as no value.
 */
export function cookieValues(req: IncomingMessage, name: string): string[] {
  return (header(req, 'cookie') ?? '').split(';').flatMap((part) => {
    const [key, ...rest] = part.trim().split('=')
    return key === name ? [rest.join('=')] : []
  })
}
