import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { cookieValues } from '../guard.ts'
import type { PreviewAccess, PreviewSession } from './access.ts'
import { absorb, cookieHeader } from './jar.ts'
import { slotPorts, type PreviewService } from './services.ts'
import type { UpstreamTarget } from './upstream.ts'

// One loopback listener per phone-preview service (W11.2), reached only through its own
// `tailscale serve` HTTPS port, so each app runs on its own origin and never on Cockpit's control
// origin. Every request and WebSocket upgrade shows the Tailscale identity for exactly this port,
// a still-paired phone and a live preview session for the service's current run; otherwise it gets
// a short page and no app content. The one unauthenticated path is the bootstrap, which takes a
// one-use ticket posted from the control origin and nothing else.
//
// Toward the dev server: no Cockpit or browser cookies, no Authorization, no Tailscale or forwarding
// headers; Host and Origin are the dev server's own. App cookies come from the Mac-side jar, and its
// Set-Cookie never reaches the browser. Absolute redirects back to the dev server become relative.

export const BOOTSTRAP_PATH = '/__cockpit/bootstrap'
export const RESERVED_PREFIX = '/__cockpit/'
export const PREVIEW_COOKIE_PREFIX = 'cockpit_pv_'
export const BODY_LIMIT = 10 * 1024 * 1024
export const HEADER_LIMIT = 32 * 1024
export const CONNECT_MS = 5_000
/** A dev server compiling on first request can be slow; past this the phone is told, not left waiting. */
export const FIRST_BYTE_MS = 60_000

export interface GatewayPolicy {
  /** This Mac's tailnet name. */
  readonly hostname: string
  readonly allowedLogins: readonly string[]
  /** https://<tailnet name>[:port] of Cockpit's phone page. */
  readonly controlOrigin: string
}

export interface GatewayDeps {
  readonly access: PreviewAccess
  readonly policy: () => GatewayPolicy | undefined
  /** The paired phone behind this request's device cookie, for this login; undefined if none or ambiguous. */
  readonly device: (req: IncomingMessage, login: string) => string | undefined
  /** The service's live upstream, or undefined while it is not running (or its port is someone else's). */
  readonly upstream: (service: PreviewService) => Promise<UpstreamTarget | undefined>
  readonly log?: (line: string) => void
  /** Loopback port for a service's listener; tests pass 0. */
  readonly listenPort?: (service: PreviewService) => number
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const STRIP = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'origin', 'referer', 'connection', 'keep-alive',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'forwarded', 'x-real-ip'])
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'trailer']

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export const previewOrigin = (hostname: string, service: PreviewService): string => `https://${hostname}:${slotPorts(service.slot).httpsPort}`
export const previewCookie = (service: PreviewService): string => `${PREVIEW_COOKIE_PREFIX}${service.slot}`

/** The Tailscale login of a request that really came through this service's Serve port, or undefined. */
export function previewLogin(req: IncomingMessage, policy: GatewayPolicy, service: PreviewService): string | undefined {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return undefined
  if (!policy.hostname || (header(req, 'host') ?? '').toLowerCase() !== `${policy.hostname}:${slotPorts(service.slot).httpsPort}`.toLowerCase()) return undefined
  if (header(req, 'x-forwarded-proto') !== 'https') return undefined
  const login = header(req, 'tailscale-user-login')
  return login && policy.allowedLogins.some((allowed) => allowed.toLowerCase() === login.toLowerCase()) ? login : undefined
}

type State = 'denied' | 'revoked' | 'expired' | 'stopped' | 'invalid-ticket' | 'unavailable' | 'too-large' | 'slow' | 'unreachable'

const STATE_TEXT: Record<State, { status: number; title: string; body: string }> = {
  denied: { status: 403, title: 'Not available', body: 'This address only works from a paired phone on your tailnet.' },
  revoked: { status: 401, title: 'This phone is signed out of Cockpit', body: 'Its access was removed on your Mac, or this browser lost its sign-in. Pair it again from Cockpit; nothing here changes your Mac.' },
  expired: { status: 401, title: 'Preview access ended', body: 'It expired, the app restarted, or this phone’s access was removed. Open the app again from Cockpit.' },
  stopped: { status: 503, title: 'The app is not running', body: 'Its dev server stopped, or its port now belongs to another program. Start it again from Cockpit; this page never starts it.' },
  'invalid-ticket': { status: 403, title: 'This link is no longer valid', body: 'Preview links work once, for 30 seconds. Open the app again from Cockpit.' },
  unavailable: { status: 404, title: 'Not found', body: 'This path is reserved by Cockpit.' },
  'too-large': { status: 413, title: 'Too large', body: 'Requests to a phone preview are limited to 10 MB.' },
  slow: { status: 504, title: 'The app did not answer', body: 'The dev server took too long to respond. Check it in Cockpit, then reload.' },
  unreachable: { status: 502, title: 'The app is not reachable', body: 'The dev server refused the connection. Check it in Cockpit, then reload.' },
}

/** A small page in place of app content, with the way back to Cockpit. Never echoes request data. */
function sendState(res: ServerResponse, state: State, controlOrigin: string | undefined, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return }
  const { status, title, body } = STATE_TEXT[state]
  const back = controlOrigin ? `<p><a href="${controlOrigin}/">Back to Cockpit</a></p>` : ''
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'x-cockpit-preview': state, ...extra,
  })
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font:16px -apple-system,system-ui,sans-serif;margin:24px;line-height:1.45"><h1 style="font-size:20px">${title}</h1><p>${body}</p>${back}</body>`)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(header(req, 'content-length') ?? 0)
    if (declared > limit) { req.resume(); reject(new RangeError('too large')); return }
    const chunks: Buffer[] = []
    let size = 0
    // Over the limit: stop keeping it and drain the rest, so the refusal is an answer, not a reset.
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > limit) { req.off('data', onData); req.resume(); reject(new RangeError('too large')) } else chunks.push(chunk)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}

function upstreamHeaders(req: IncomingMessage, target: UpstreamTarget, session: PreviewSession, path: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIP.has(name) || name.startsWith('tailscale-') || name.startsWith('x-forwarded-')) continue
    out[name] = value
  }
  out.host = target.host
  if (req.headers.origin) out.origin = `http://${target.host}`
  const cookies = cookieHeader(session.jar, path)
  if (cookies) out.cookie = cookies
  return out
}

/** Absolute redirects to the dev server itself become paths on the preview origin; others pass unchanged. */
export function rewriteLocation(location: string, target: UpstreamTarget): string {
  let url: URL
  try { url = new URL(location) } catch { return location }
  const local = url.protocol === 'http:' && Number(url.port || 80) === target.port && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)
  return local ? `${url.pathname}${url.search}${url.hash}` || '/' : location
}

export interface PreviewGateway {
  /** Opens the listener for a service (idempotent); resolves to its loopback port. */
  open(service: PreviewService): Promise<number>
  close(serviceId: string): Promise<void>
  closeAll(): Promise<void>
  /** Services with a listener open. */
  openIds(): string[]
}

export function createPreviewGateway(deps: GatewayDeps): PreviewGateway {
  const servers = new Map<string, Server>()
  const log = deps.log ?? (() => undefined)

  /** Policy, login, phone and session for a request, or the state to show instead. */
  async function admit(req: IncomingMessage, service: PreviewService): Promise<{ session: PreviewSession; target: UpstreamTarget } | { state: State; policy?: GatewayPolicy }> {
    const policy = deps.policy()
    const login = policy && previewLogin(req, policy, service)
    if (!policy || !login) return { state: 'denied', ...(policy ? { policy } : {}) }
    const target = await deps.upstream(service)
    const deviceId = deps.device(req, login)
    if (!deviceId) return { state: 'revoked', policy }
    const session = deps.access.session(cookieValues(req, previewCookie(service)).length === 1 ? cookieValues(req, previewCookie(service))[0] : undefined,
      { serviceId: service.id, login, generation: target?.generation })
    if (!session || session.deviceId !== deviceId) return { state: target ? 'expired' : 'stopped', policy }
    if (!target) return { state: 'stopped', policy }
    return { session, target }
  }

  async function bootstrap(req: IncomingMessage, res: ServerResponse, service: PreviewService): Promise<void> {
    const policy = deps.policy()
    const login = policy && previewLogin(req, policy, service)
    if (!policy || !login) return sendState(res, 'denied', policy?.controlOrigin)
    if (req.method !== 'POST') return sendState(res, 'invalid-ticket', policy.controlOrigin)
    let ticket: string | null
    try { ticket = new URLSearchParams((await readBody(req, 4096)).toString('utf8')).get('ticket') } catch { return sendState(res, 'invalid-ticket', policy.controlOrigin) }
    // A ticket is used up the first time it is seen, valid or not: posted from anywhere but the
    // control origin it is consumed and refused.
    const fromControl = header(req, 'origin') === policy.controlOrigin
    const deviceId = deps.device(req, login)
    const target = await deps.upstream(service)
    const outcome = ticket ? deps.access.redeem(ticket, { deviceId: deviceId ?? '', login, serviceId: service.id, generation: fromControl ? target?.generation : undefined, origin: previewOrigin(policy.hostname, service) }) : { refused: 'unknown' as const }
    log(`preview ${service.slot} bootstrap ${'session' in outcome ? 'accepted' : `refused (${outcome.refused})`}`)
    if (!('session' in outcome)) return sendState(res, target ? 'invalid-ticket' : 'stopped', policy.controlOrigin)
    res.writeHead(303, {
      location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': `${previewCookie(service)}=${outcome.session.id}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    })
    res.end()
  }

  async function handle(req: IncomingMessage, res: ServerResponse, service: PreviewService): Promise<void> {
    const path = req.url ?? '/'
    if (path === BOOTSTRAP_PATH || path.startsWith(`${BOOTSTRAP_PATH}?`)) return bootstrap(req, res, service)
    if (path.startsWith(RESERVED_PREFIX)) return sendState(res, 'unavailable', deps.policy()?.controlOrigin)
    const admitted = await admit(req, service)
    if ('state' in admitted) return sendState(res, admitted.state, admitted.policy?.controlOrigin)
    const { session, target } = admitted
    if (req.method === 'CONNECT' || !path.startsWith('/')) return sendState(res, 'unavailable', deps.policy()?.controlOrigin)
    let body: Buffer | undefined
    try { body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, BODY_LIMIT) } catch {
      return sendState(res, 'too-large', deps.policy()?.controlOrigin)
    }
    const release = deps.access.hold(session.id, res)
    res.once('close', release)
    const upstream = httpRequest({ host: target.hostname, port: target.port, method: req.method, path, headers: upstreamHeaders(req, target, session, path) }, (upRes) => {
      clearTimeout(firstByte)
      const headers = { ...upRes.headers }
      absorb(session.jar, headers['set-cookie'], path)
      delete headers['set-cookie']
      for (const name of HOP) delete headers[name]
      if (typeof headers.location === 'string') headers.location = rewriteLocation(headers.location, target)
      res.writeHead(upRes.statusCode ?? 502, headers)
      upRes.pipe(res)
      // Streams (SSE) live as long as the session allows, not by a body timeout.
      res.once('close', () => upRes.destroy())
    })
    const firstByte = setTimeout(() => { upstream.destroy(); sendState(res, 'slow', deps.policy()?.controlOrigin) }, FIRST_BYTE_MS)
    upstream.once('socket', (socket: Socket) => {
      if (!socket.connecting) return
      socket.setTimeout(CONNECT_MS, () => upstream.destroy(new Error('connect timeout')))
      socket.once('connect', () => socket.setTimeout(0))
    })
    upstream.once('error', (error) => { clearTimeout(firstByte); if (!res.headersSent) sendState(res, error.message === 'connect timeout' ? 'slow' : 'unreachable', deps.policy()?.controlOrigin); else res.destroy() })
    upstream.end(body)
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, service: PreviewService): Promise<void> {
    const refuse = (status: number, why: string): void => { log(`preview ${service.slot} websocket refused (${why})`); socket.end(`HTTP/1.1 ${status} Refused\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`) }
    const admitted = await admit(req, service)
    if ('state' in admitted) return refuse(STATE_TEXT[admitted.state].status, admitted.state)
    const policy = deps.policy()
    if (!policy || header(req, 'origin') !== previewOrigin(policy.hostname, service)) return refuse(403, 'origin')
    const { session, target } = admitted
    const path = req.url ?? '/'
    const headers = { ...upstreamHeaders(req, target, session, path), connection: 'Upgrade', upgrade: header(req, 'upgrade') ?? 'websocket' }
    const upstream = httpRequest({ host: target.hostname, port: target.port, method: req.method ?? 'GET', path, headers })
    let up: Duplex | undefined
    const release = deps.access.hold(session.id, { destroy: () => { socket.destroy(); up?.destroy(); upstream.destroy() } })
    socket.once('close', () => { release(); up?.destroy(); upstream.destroy() })
    upstream.once('socket', (s: Socket) => {
      if (!s.connecting) return
      s.setTimeout(CONNECT_MS, () => upstream.destroy())
      s.once('connect', () => s.setTimeout(0))
    })
    // The dev server's own handshake answer, minus its cookies (into the jar) and hop headers.
    upstream.once('upgrade', (upRes, upSocket, upHead) => {
      up = upSocket
      absorb(session.jar, upRes.headers['set-cookie'], path)
      const lines = Object.entries(upRes.headers).filter(([name]) => name !== 'set-cookie' && !['keep-alive', 'transfer-encoding', 'proxy-connection', 'trailer'].includes(name))
        .flatMap(([name, value]) => (value === undefined ? [] : [value].flat().map((v) => `${name}: ${v}`)))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.once('close', () => socket.destroy())
    })
    upstream.once('response', (upRes) => { upRes.resume(); refuse(upRes.statusCode ?? 502, 'upstream did not switch') })
    upstream.once('error', () => socket.destroy())
    upstream.end()
  }

  return {
    async open(service) {
      const running = servers.get(service.id)
      if (running) return (running.address() as AddressInfo).port
      const server = createServer({ maxHeaderSize: HEADER_LIMIT }, (req, res) => {
        handle(req, res, service).catch(() => { if (!res.headersSent) sendState(res, 'unreachable', deps.policy()?.controlOrigin); else res.destroy() })
      })
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { upgrade(req, socket, head, service).catch(() => socket.destroy()) })
      server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); else socket.destroy() })
      servers.set(service.id, server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          servers.delete(service.id)
          reject(new Error(error.code === 'EADDRINUSE' ? `Port ${slotPorts(service.slot).listenPort} is already in use on this Mac` : error.message))
        })
        server.listen(deps.listenPort?.(service) ?? slotPorts(service.slot).listenPort, '127.0.0.1', () => resolve())
      })
      return (server.address() as AddressInfo).port
    },
    async close(serviceId) {
      const server = servers.get(serviceId)
      servers.delete(serviceId)
      if (!server) return
      deps.access.revoke({ serviceId })
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    },
    async closeAll() {
      for (const id of [...servers.keys()]) await this.close(id)
    },
    openIds: () => [...servers.keys()],
  }
}
