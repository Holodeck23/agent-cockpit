import type { IncomingMessage } from 'node:http'

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
// A local process can forge these headers by calling the port directly, but it
// can already call the desktop API, so that is no new access.

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

/** API routes the phone may use: read conversations, reply, answer approvals, stop. */
const REMOTE_ROUTES: readonly [string, RegExp][] = [
  ['GET', /^\/api\/stream$/],
  ['GET', /^\/api\/threads$/],
  ['GET', /^\/api\/threads\/[^/]+\/events$/],
  ['POST', /^\/api\/threads\/[^/]+\/messages$/],
  ['POST', /^\/api\/threads\/[^/]+\/approvals\/[^/]+$/],
  ['POST', /^\/api\/threads\/[^/]+\/interrupt$/],
  ['GET', /^\/api\/projects$/],
  ['GET', /^\/api\/processes$/],
]

export function isRemoteRoute(method: string, pathname: string): boolean {
  return REMOTE_ROUTES.some(([m, pattern]) => m === method && pattern.test(pathname))
}

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}
