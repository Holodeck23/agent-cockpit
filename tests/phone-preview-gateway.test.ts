import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieValues } from '../server/remote/guard.ts'
import { createPreviewAccess } from '../server/remote/preview/access.ts'
import { createPreviewGateway, type PreviewGateway } from '../server/remote/preview/gateway.ts'
import type { PreviewService } from '../server/remote/preview/services.ts'
import type { UpstreamTarget } from '../server/remote/preview/upstream.ts'

// The gateway between a paired phone and one dev server (W11-01–05, W11-07, SEC-04–06), against a
// real fixture app. Requests arrive the way Tailscale Serve delivers them: from loopback, with the
// preview's own Host, https and the Tailscale login.

const HOSTNAME = 'mac.tail.ts.net'
const CONTROL = `https://${HOSTNAME}`
const ORIGIN = `https://${HOSTNAME}:8443`
const service: PreviewService = { id: 'svc-a', slot: 0, projectPath: '/p', name: 'dev', commandHash: '0'.repeat(64), createdAt: '' }
const DEVICE_TOKEN = 'device-token'

let app: Server
let appPort = 0
let seen: IncomingHttpHeaders = {}
let gateway: PreviewGateway
let port = 0
let generation: string | undefined = 'g1'
const access = createPreviewAccess()

beforeAll(async () => {
  app = createServer((req, res) => {
    seen = req.headers
    const url = req.url ?? '/'
    if (url === '/login') { res.writeHead(200, { 'set-cookie': 'sid=signed-in; Path=/; HttpOnly' }); return void res.end('ok') }
    if (url === '/whoami') return void res.end(req.headers.cookie?.includes('sid=signed-in') ? 'signed in' : 'anonymous')
    if (url === '/redirect') { res.writeHead(302, { location: `http://localhost:${appPort}/landed?x=1` }); return void res.end() }
    if (url === '/away') { res.writeHead(302, { location: 'https://example.com/' }); return void res.end() }
    if (url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return void res.write('data: hello\n\n') }
    if (url === '/upload') { req.resume(); req.on('end', () => res.end('stored')); return }
    res.end('<h1>fixture app</h1>')
  })
  app.on('upgrade', (req, socket) => {
    seen = req.headers
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nset-cookie: ws=leak\r\n\r\n')
    // The fixture app's own socket: its resets are the fixture's, not the gateway's, so it listens.
    socket.on('error', () => socket.destroy())
    socket.on('data', (d) => socket.write(d))
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
  appPort = (app.address() as AddressInfo).port
  gateway = createPreviewGateway({
    access,
    policy: () => ({ hostname: HOSTNAME, allowedLogins: ['me@x'], controlOrigin: CONTROL }),
    device: (req) => { const values = cookieValues(req, 'cockpit_device'); return values.length === 1 && values[0] === DEVICE_TOKEN ? 'd1' : undefined },
    upstream: async (): Promise<UpstreamTarget | undefined> => (generation ? { hostname: '127.0.0.1', port: appPort, host: `localhost:${appPort}`, generation } : undefined),
    listenPort: () => 0,
  })
  port = await gateway.open(service)
})
afterAll(async () => { await gateway.closeAll(); app.close() })

const via = (extra: Record<string, string> = {}): Record<string, string> => ({
  host: `${HOSTNAME}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=${DEVICE_TOKEN}`, ...extra,
})
function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? via() }, (res) => {
      if (res.headers['content-type'] === 'text/event-stream') { res.once('data', (d: Buffer) => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: d.toString(), res })); return }
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString(), res }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}
async function bootstrap(ticket: string, headers: Record<string, string> = {}): Promise<{ status: number; session?: string; text: string }> {
  const r = await call('/__cockpit/bootstrap', { method: 'POST', body: `ticket=${ticket}`, headers: via({ origin: CONTROL, 'content-type': 'application/x-www-form-urlencoded', ...headers }) })
  const cookie = [r.headers['set-cookie'] ?? []].flat()[0]
  return { status: r.status, text: r.text, ...(cookie ? { session: /cockpit_pv_0=([^;]+)/.exec(cookie)?.[1] } : {}) }
}
const grant = () => ({ deviceId: 'd1', login: 'me@x', serviceId: 'svc-a', generation: generation ?? '', origin: ORIGIN })
async function signIn(): Promise<string> {
  const b = await bootstrap(access.issue(grant()))
  if (!b.session) throw new Error(`bootstrap failed: ${b.status}`)
  return b.session
}
const withSession = (session: string, extra: Record<string, string> = {}) => via({ cookie: `cockpit_device=${DEVICE_TOKEN}; cockpit_pv_0=${session}`, ...extra })

describe('phone preview gateway', () => {
  it('serves no app content without access, and only through Tailscale for this port', async () => {
    const none = await call('/')
    expect(none.status).toBe(401)
    expect(none.text).not.toContain('fixture app')
    expect((await call('/', { headers: via({ host: `${HOSTNAME}:8444` }) })).status).toBe(403)
    expect((await call('/', { headers: via({ 'tailscale-user-login': 'stranger@x' }) })).status).toBe(403)
    expect((await call('/', { headers: { host: `${HOSTNAME}:8443`, 'tailscale-user-login': 'me@x' } })).status).toBe(403)
  })

  it('a ticket from the control origin opens a session once; replay, wrong origin and expiry fail (W11-02)', async () => {
    const ticket = access.issue(grant())
    expect((await bootstrap(ticket, { origin: ORIGIN })).status).toBe(403)
    expect((await bootstrap(ticket)).status).toBe(403)
    const fresh = access.issue(grant())
    const ok = await bootstrap(fresh)
    expect(ok.status).toBe(303)
    expect(ok.session).toBeTruthy()
    expect((await bootstrap(fresh)).status).toBe(403)
    expect((await bootstrap(access.issue({ ...grant(), deviceId: 'd2' }))).status).toBe(403)
    const page = await call('/', { headers: withSession(ok.session!) })
    expect(page.status).toBe(200)
    expect(page.text).toContain('fixture app')
  })

  it('a ticket is refused without the paired phone, or with two device cookies (SEC-04)', async () => {
    expect((await bootstrap(access.issue(grant()), { cookie: 'cockpit_device=other' })).status).toBe(403)
    expect((await bootstrap(access.issue(grant()), { cookie: `cockpit_device=${DEVICE_TOKEN}; cockpit_device=forged` })).status).toBe(403)
  })

  it('strips Cockpit, browser and Tailscale credentials before the dev server (SEC-05)', async () => {
    const session = await signIn()
    await call('/echo', { headers: withSession(session, { authorization: 'Bearer secret', 'x-forwarded-for': '100.64.0.1', 'tailscale-user-name': 'Me', origin: ORIGIN, referer: `${ORIGIN}/x` }) })
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(Object.keys(seen).filter((h) => h.startsWith('tailscale-') || h.startsWith('x-forwarded-'))).toEqual([])
    expect(seen.host).toBe(`localhost:${appPort}`)
    expect(seen.origin).toBe(`http://localhost:${appPort}`)
    expect(seen.referer).toBeUndefined()
  })

  it('keeps app cookies on the Mac and sends them back to the app only (W11-03)', async () => {
    const session = await signIn()
    const login = await call('/login', { headers: withSession(session) })
    expect(login.headers['set-cookie']).toBeUndefined()
    expect((await call('/whoami', { headers: withSession(session) })).text).toBe('signed in')
    // A new session for the same phone and app keeps the sign-in.
    expect((await call('/whoami', { headers: withSession(await signIn()) })).text).toBe('signed in')
  })

  it('rewrites redirects back to the app, leaves others, streams SSE and caps bodies (W11-03, W11-07)', async () => {
    const session = await signIn()
    expect((await call('/redirect', { headers: withSession(session) })).headers.location).toBe('/landed?x=1')
    expect((await call('/away', { headers: withSession(session) })).headers.location).toBe('https://example.com/')
    const sse = await call('/sse', { headers: withSession(session) })
    expect(sse.text).toContain('data: hello')
    sse.res.destroy()
    const big = await call('/upload', { method: 'POST', headers: withSession(session, { 'content-type': 'application/octet-stream' }), body: Buffer.alloc(10 * 1024 * 1024 + 1) })
    expect(big.status).toBe(413)
    expect((await call('/upload', { method: 'POST', headers: withSession(session), body: 'small' })).text).toBe('stored')
    expect((await call('/', { headers: withSession(session, { 'x-big': 'a'.repeat(40 * 1024) }) }).catch(() => ({ status: 431 }))).status).toBe(431)
    expect((await call('/__cockpit/anything', { headers: withSession(session) })).status).toBe(404)
  })

  it('refuses a write that another origin sends with this app\'s cookie, and lets its own through (W11-04)', async () => {
    const session = await signIn()
    seen = {}
    const other = await call('/upload', { method: 'POST', headers: withSession(session, { origin: `https://${HOSTNAME}:8444` }), body: 'from B' })
    expect([other.status, other.headers['x-cockpit-preview']]).toEqual([403, 'cross-site'])
    expect(seen).toEqual({})
    expect((await call('/upload', { method: 'POST', headers: withSession(session, { origin: CONTROL }), body: 'from control' })).status).toBe(403)
    expect((await call('/upload', { method: 'POST', headers: withSession(session, { origin: ORIGIN }), body: 'own' })).text).toBe('stored')
    expect((await call('/upload', { method: 'POST', headers: withSession(session), body: 'no origin' })).text).toBe('stored')
    expect((await call('/', { headers: withSession(session, { origin: `https://${HOSTNAME}:8444` }) })).status).toBe(200)
  })

  it('a stopped app shows stopped, and a restart needs fresh access (W11-05, SEC-06)', async () => {
    const session = await signIn()
    generation = undefined
    const stopped = await call('/', { headers: withSession(session) })
    expect(stopped.status).toBe(503)
    expect(stopped.text).not.toContain('fixture app')
    generation = 'g2'
    expect((await call('/', { headers: withSession(session) })).status).toBe(401)
    expect((await call('/', { headers: withSession(await signIn()) })).status).toBe(200)
  })

  it('a phone that drops a live WebSocket (TCP reset) while the app is still sending raises nothing uncaught', async () => {
    // In Cockpit's Electron main process an uncaught socket error opens a modal error dialog that
    // freezes the server; proof:wave-11 hit it when the tailnet dropped mid-HMR.
    const session = await signIn()
    const uncaught: unknown[] = []
    const onError = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', onError)
    try {
      for (let round = 0; round < 5; round += 1) {
        const socket = connect(port, '127.0.0.1')
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
        const headers = { ...withSession(session), origin: ORIGIN, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }
        socket.write(`GET /hmr HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
        await new Promise<void>((resolve) => socket.once('data', () => resolve()))
        socket.on('error', () => undefined)
        // The app echoes; keep it busy, then vanish with a reset instead of a close.
        for (let i = 0; i < 20; i += 1) socket.write(Buffer.alloc(64 * 1024, 120))
        socket.resetAndDestroy()
        await new Promise((r) => setTimeout(r, 100))
      }
      await new Promise((r) => setTimeout(r, 200))
    } finally {
      process.off('uncaughtException', onError)
    }
    expect(uncaught.map(String)).toEqual([])
    expect((await call('/', { headers: withSession(session) })).status).toBe(200)
  })

  it('WebSockets need the exact preview origin; the dev server’s cookies stay out; revocation closes them (SEC-04, SEC-06)', async () => {
    const session = await signIn()
    const open = (origin: string): Promise<{ head: string; socket: import('node:net').Socket }> => new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        const headers = { ...withSession(session), origin, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }
        socket.write(`GET /hmr?token=vite HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      })
      socket.once('data', (d: Buffer) => resolve({ head: d.toString(), socket }))
      socket.once('error', reject)
    })
    for (const wrong of [CONTROL, 'https://mac.tail.ts.net:8444', 'https://evil.example']) {
      const r = await open(wrong)
      expect(r.head).toMatch(/^HTTP\/1\.1 403/)
      r.socket.destroy()
    }
    const ok = await open(ORIGIN)
    expect(ok.head).toMatch(/^HTTP\/1\.1 101/)
    expect(ok.head).not.toMatch(/set-cookie/i)
    // Only the app's own jar cookies (sid, from the sign-in above) go upstream; nothing of Cockpit's.
    expect(seen.cookie ?? '').not.toMatch(/cockpit_/)
    expect(seen['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==')
    const echoed = new Promise<string>((resolve) => ok.socket.once('data', (d: Buffer) => resolve(d.toString())))
    ok.socket.write('ping')
    expect(await echoed).toBe('ping')
    const closed = new Promise<void>((resolve) => ok.socket.once('close', () => resolve()))
    access.revoke({ deviceId: 'd1' })
    await closed
    expect((await call('/', { headers: withSession(session) })).status).toBe(401)
  })
})
