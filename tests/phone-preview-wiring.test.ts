import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tailscale } from '../server/remote/tailscale.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

// Phone previews in the running app (order 14c): the Mac turns a running process's phone origin on,
// the paired phone gets a one-use ticket from the control listener and opens the app on the
// preview listener. Requests arrive the way Tailscale Serve delivers them. A real dev-server stand-in
// runs as a Cockpit process, so the port-ownership check is the real one (lsof + process group).

const HOST = 'mac.example.ts.net'
const OWNER = 'owner@example.com'
const CONTROL = `https://${HOST}`
const PREVIEW = `https://${HOST}:8443`

const APP = `require('http').createServer((q,s)=>{if(q.url==='/sse'){s.writeHead(200,{'content-type':'text/event-stream'});return s.write('data: hi\\n\\n')}s.setHeader('content-type','text/plain');s.end('fixture '+q.url+' cookie='+(q.headers.cookie||'none')+' host='+q.headers.host)}).listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port+'/')})`

interface Reply { status: number; body: string; headers: IncomingHttpHeaders }
function call(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', agent: false, headers: init.headers ?? {} }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Tailscale with one Serve table, keyed by HTTPS port like the real one. */
function fakeTailscale() {
  const table = new Map<number, string>()
  const calls: string[] = []
  const tailscale: Tailscale = {
    self: async () => ({ hostname: HOST, login: OWNER }),
    serveTarget: async (_host, httpsPort) => table.get(httpsPort),
    serve: async (port, httpsPort) => { calls.push(`serve ${httpsPort} -> ${port}`); table.set(httpsPort, `http://127.0.0.1:${port}`) },
    unserve: async (httpsPort) => { calls.push(`off ${httpsPort}`); table.delete(httpsPort) },
  }
  return { tailscale, table, calls }
}

let server: RunningServer | undefined
afterEach(async () => { await server?.close(); server = undefined })

async function freePort(): Promise<number> {
  const probe = netServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** An open event stream through the preview, and whether it has ended. */
function openStream(port: number, headers: Record<string, string>): Promise<{ ended: () => boolean; stop: () => void }> {
  return new Promise((resolve, reject) => {
    let ended = false
    const req = request({ host: '127.0.0.1', port, path: '/sse', agent: false, headers }, (res) => {
      res.on('close', () => { ended = true })
      res.once('data', () => resolve({ ended: () => ended, stop: () => req.destroy() }))
      if (res.statusCode !== 200) reject(new Error(`stream got ${res.statusCode}`))
    })
    req.on('error', () => { ended = true })
    req.end()
  })
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function setup(listenPort = 0) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-pv-state-'))
  const web = mkdtempSync(join(tmpdir(), 'cockpit-pv-web-'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Cockpit</title>')
  const launcher: Launcher = (_req, emit) => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
    close: async () => { emit({ kind: 'exit', code: 0 }) } })
  const ts = fakeTailscale()
  server = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
    remote: { tailscale: ts.tailscale, port: 0, previewListenPort: listenPort } })
  const s = server
  const local = (path: string, body?: unknown) => call(s.port, path, body === undefined ? {} : json(body))
  expect((await local('/api/remote', { enabled: true })).status).toBe(200)
  const phonePort = s.remote.port()!
  const via = (extra: Record<string, string> = {}) => ({ host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...extra })
  const pairing = JSON.parse((await call(phonePort, '/api/remote/pair', { ...json({ name: 'Pixel' }), headers: via({ 'content-type': 'application/json' }) })).body).data
  await local(`/api/remote/pairings/${pairing.id}`, { approve: true })
  const device = String((await call(phonePort, `/api/remote/pair/${pairing.id}`, { headers: via() })).headers['set-cookie']?.[0]).split(';')[0]!
  // Phone access on again binds a new port (port 0), so ask for it each time.
  const phone = (path: string, body?: unknown, extra: Record<string, string> = {}) => call(s.remote.port()!, path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: via({ cookie: device, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: CONTROL }), ...extra }),
  })
  return { s, root, ts, local, phone, device, phonePort, via }
}

type Ctx = Awaited<ReturnType<typeof setup>>

/** Turns the app's preview on, then signs the phone in with a fresh ticket. */
async function signIn(ctx: Ctx, processId: string, serve = true) {
  if (serve) {
    const { serviceId } = JSON.parse((await ctx.local('/api/phone/previews', { processId })).body).data
    await ctx.local(`/api/phone/previews/${serviceId}/serve`, {})
  }
  const status = JSON.parse((await ctx.local('/api/phone/previews')).body).data
  const gw = status.services[0].serve.listenPort as number
  const issued = await ctx.phone('/api/phone/preview-tickets', { processId })
  expect(issued.status).toBe(201)
  const { ticket } = JSON.parse(issued.body).data
  const viaPreview = (extra: Record<string, string> = {}) => ({ host: `${HOST}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...extra })
  const boot = await call(gw, '/__cockpit/bootstrap', { method: 'POST', body: `ticket=${ticket}`,
    headers: viaPreview({ origin: CONTROL, cookie: ctx.device, 'content-type': 'application/x-www-form-urlencoded' }) })
  expect(boot.status).toBe(303)
  const headers: Record<string, string> = viaPreview({ cookie: `${ctx.device}; ${String(boot.headers['set-cookie']?.[0]).split(';')[0]}` })
  return { gw, headers, serviceId: status.services[0].id as string }
}

async function startApp(s: RunningServer, root: string, name = 'web') {
  const { process: started } = s.processes.start({ projectPath: root, command: `"${process.execPath}" -e "${APP}"`, name }, { kind: 'user' })
  for (let i = 0; i < 100 && !s.processes.get(started.id)?.url; i += 1) await new Promise((r) => setTimeout(r, 50))
  expect(s.processes.get(started.id)?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  return started.id
}

describe('phone previews in the app (14c)', () => {
  it('turns a running app on from the Mac, runs only the shown Serve entry, and opens it on its own origin', async () => {
    const { s, root, ts, local, phone, device } = await setup()
    const processId = await startApp(s, root)

    // Not on yet: the phone is told so, and nothing changed in Tailscale.
    const early = await phone('/api/phone/preview-tickets', { processId })
    expect(early.status).toBe(409)
    expect(JSON.parse(early.body).state).toBe('not-enabled')
    expect(ts.calls).toEqual(['serve 443 -> ' + s.remote.port()])

    const listed = JSON.parse((await local('/api/phone/previews')).body).data
    expect(listed.candidates.map((c: { processId: string }) => c.processId)).toEqual([processId])
    const prepared = JSON.parse((await local('/api/phone/previews', { processId })).body).data
    const shown = prepared.status.services[0]
    expect(shown.serve.command).toBe('tailscale serve --bg --https=8443 http://127.0.0.1:47822')
    expect(shown.tailscale).toBe('none')
    expect(shown.open).toBe(false)
    expect(ts.calls).toHaveLength(1)

    const served = JSON.parse((await local(`/api/phone/previews/${prepared.serviceId}/serve`, {})).body).data.services[0]
    expect(served.open).toBe(true)
    expect(served.tailscale).toBe('cockpit')
    expect(ts.calls[1]).toBe(`serve 8443 -> ${served.serve.listenPort}`)
    expect(ts.table.get(443)).toBe(`http://127.0.0.1:${s.remote.port()}`)

    const issued = await phone('/api/phone/preview-tickets', { processId })
    expect(issued.status).toBe(201)
    const ticket = JSON.parse(issued.body).data
    expect(ticket).toMatchObject({ origin: PREVIEW, bootstrap: `${PREVIEW}/__cockpit/bootstrap`, target: 'preview-0' })

    const gw = served.serve.listenPort as number
    const viaPreview = (extra: Record<string, string> = {}) => ({ host: `${HOST}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...extra })
    const boot = await call(gw, '/__cockpit/bootstrap', { method: 'POST', body: `ticket=${ticket.ticket}`,
      headers: viaPreview({ origin: CONTROL, cookie: device, 'content-type': 'application/x-www-form-urlencoded' }) })
    expect(boot.status).toBe(303)
    const pv = String(boot.headers['set-cookie']?.[0]).split(';')[0]!
    expect(pv).toMatch(/^cockpit_pv_0=/)
    const page = await call(gw, '/deep/link', { headers: viaPreview({ cookie: `${device}; ${pv}` }) })
    expect(page.status).toBe(200)
    expect(page.body).toMatch(/^fixture \/deep\/link cookie=none host=127\.0\.0\.1:\d+$/)

    // The ticket was used up.
    const replay = await call(gw, '/__cockpit/bootstrap', { method: 'POST', body: `ticket=${ticket.ticket}`,
      headers: viaPreview({ origin: CONTROL, cookie: device, 'content-type': 'application/x-www-form-urlencoded' }) })
    expect(replay.status).toBe(403)
  }, 20_000)

  it('refuses tickets for unknown, stopped and address-less processes, and keeps setup on the Mac', async () => {
    const { s, root, local, phone } = await setup()
    expect(JSON.parse((await phone('/api/phone/preview-tickets', { processId: 'nope' })).body).state).toBe('stopped')
    const quiet = s.processes.start({ projectPath: root, command: 'sleep 30', name: 'quiet' }, { kind: 'user' }).process
    expect(JSON.parse((await phone('/api/phone/preview-tickets', { processId: quiet.id })).body).state).toBe('no-local-url')
    expect((await local('/api/phone/previews', { processId: quiet.id })).status).toBe(409)
    // The phone cannot list, turn on or serve previews.
    expect((await phone('/api/phone/previews')).status).toBe(403)
    expect((await phone('/api/phone/previews', { processId: quiet.id })).status).toBe(403)
  }, 20_000)

  it('will not take over an HTTPS port that already serves something else', async () => {
    const { s, root, ts, local } = await setup()
    const processId = await startApp(s, root)
    ts.table.set(8443, 'http://127.0.0.1:9999')
    const { serviceId } = JSON.parse((await local('/api/phone/previews', { processId })).body).data
    const refused = await local(`/api/phone/previews/${serviceId}/serve`, {})
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.body).error).toContain('http://127.0.0.1:9999')
    expect(ts.table.get(8443)).toBe('http://127.0.0.1:9999')
    const after = JSON.parse((await local('/api/phone/previews')).body).data.services[0]
    expect(after).toMatchObject({ open: false, tailscale: 'other', other: 'http://127.0.0.1:9999' })
  }, 20_000)

  it('unserve removes only its own entry and closes the listener', async () => {
    const { s, root, ts, local, phone } = await setup()
    const processId = await startApp(s, root)
    const { serviceId } = JSON.parse((await local('/api/phone/previews', { processId })).body).data
    const gw = JSON.parse((await local(`/api/phone/previews/${serviceId}/serve`, {})).body).data.services[0].serve.listenPort as number
    const off = JSON.parse((await local(`/api/phone/previews/${serviceId}/unserve`, {})).body).data.services[0]
    expect(off).toMatchObject({ open: false, tailscale: 'none' })
    expect(ts.calls.at(-1)).toBe('off 8443')
    expect(ts.table.has(443)).toBe(true)
    await expect(call(gw, '/')).rejects.toThrow()
    expect(JSON.parse((await phone('/api/phone/preview-tickets', { processId })).body).state).toBe('not-enabled')
  }, 20_000)
})

describe('phone preview access ends (14c revocation)', () => {
  it('a stop or restart ends sessions and open streams; a restart needs a fresh ticket', async () => {
    const ctx = await setup()
    const first = await startApp(ctx.s, ctx.root)
    const a = await signIn(ctx, first)
    expect((await call(a.gw, '/', { headers: a.headers })).status).toBe(200)
    const stream = await openStream(a.gw, a.headers)

    const second = (await ctx.s.processes.restart(first)).id
    for (let i = 0; i < 100 && !ctx.s.processes.get(second)?.url; i += 1) await settle(50)
    await settle()
    expect(stream.ended()).toBe(true)
    const old = await call(a.gw, '/', { headers: a.headers })
    expect([old.status, old.headers['x-cockpit-preview']]).toEqual([401, 'expired'])
    expect(old.body).not.toContain('fixture')

    const b = await signIn(ctx, second, false)
    expect((await call(b.gw, '/', { headers: b.headers })).body).toContain('fixture')
    await ctx.s.processes.stop(second)
    await settle()
    const stopped = await call(b.gw, '/', { headers: b.headers })
    expect([stopped.status, stopped.headers['x-cockpit-preview']]).toEqual([503, 'stopped'])
    expect(JSON.parse((await ctx.phone('/api/phone/preview-tickets', { processId: second })).body).state).toBe('stopped')
  }, 30_000)

  it('removing the phone ends its sessions and streams at once', async () => {
    const ctx = await setup()
    const id = await startApp(ctx.s, ctx.root)
    const a = await signIn(ctx, id)
    const stream = await openStream(a.gw, a.headers)
    const device = JSON.parse((await ctx.local('/api/remote')).body).data.devices[0]
    await ctx.local(`/api/remote/devices/${device.id}/revoke`, {})
    await settle()
    expect(stream.ended()).toBe(true)
    const gone = await call(a.gw, '/', { headers: a.headers })
    expect([gone.status, gone.headers['x-cockpit-preview']]).toEqual([401, 'revoked'])
    expect((await ctx.phone('/api/phone/preview-tickets', { processId: id })).status).toBe(401)
  }, 30_000)

  it('phone access off closes previews without touching their Serve entries; back on, access starts over', async () => {
    const ctx = await setup(await freePort())
    const id = await startApp(ctx.s, ctx.root)
    const a = await signIn(ctx, id)
    const stream = await openStream(a.gw, a.headers)
    await ctx.local('/api/remote', { enabled: false })
    await settle()
    expect(stream.ended()).toBe(true)
    await expect(call(a.gw, '/', { headers: a.headers })).rejects.toThrow()
    expect(ctx.ts.table.get(8443)).toBe(`http://127.0.0.1:${a.gw}`)
    expect(ctx.ts.calls.filter((c) => c.includes('8443'))).toEqual([`serve 8443 -> ${a.gw}`])

    await ctx.local('/api/remote', { enabled: true })
    const back = JSON.parse((await ctx.local('/api/phone/previews')).body).data.services[0]
    expect(back).toMatchObject({ open: true, tailscale: 'cockpit' })
    const old = await call(a.gw, '/', { headers: a.headers })
    expect([old.status, old.headers['x-cockpit-preview']]).toEqual([401, 'expired'])
    const fresh = await signIn(ctx, id, false)
    expect((await call(fresh.gw, '/', { headers: fresh.headers })).body).toContain('fixture')
  }, 30_000)

  it('removing the project retires its previews for good and keeps their origin reserved', async () => {
    const ctx = await setup()
    expect((await ctx.local('/api/projects', { path: ctx.root })).status).toBe(200)
    const id = await startApp(ctx.s, ctx.root)
    const a = await signIn(ctx, id)
    const stream = await openStream(a.gw, a.headers)
    expect((await ctx.local('/api/projects/remove', { path: ctx.root })).status).toBe(200)
    await settle()
    expect(stream.ended()).toBe(true)
    await expect(call(a.gw, '/', { headers: a.headers })).rejects.toThrow()
    const after = JSON.parse((await ctx.local('/api/phone/previews')).body).data
    expect(after.services[0]).toMatchObject({ retired: true, open: false, slot: 0 })
    expect((await ctx.local(`/api/phone/previews/${a.serviceId}/serve`, {})).status).toBe(404)
    // Offered again, it gets a new origin; slot 0 is never handed out again.
    const again = JSON.parse((await ctx.local('/api/phone/previews', { processId: id })).body).data
    expect(again.status.services.find((v: { id: string }) => v.id === again.serviceId).slot).toBe(1)
  }, 30_000)
})

describe('the control origin against preview origins (SEC-04, 14c)', () => {
  it('lets the phone page post only to preview origins, and nothing frame it', async () => {
    const ctx = await setup()
    const page = await call(ctx.s.remote.port()!, '/', { headers: ctx.via() })
    expect(page.status).toBe(200)
    const csp = String(page.headers['content-security-policy'])
    expect(csp).toContain(`form-action 'self' ${PREVIEW} `)
    expect(csp).toContain(`https://${HOST}:8458;`)
    expect(csp).not.toContain(':8459')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(page.headers['x-frame-options']).toBe('DENY')
    // The desktop page keeps form-action 'self'.
    expect(String((await call(ctx.s.port, '/')).headers['content-security-policy'])).toContain("form-action 'self';")
    const api = await ctx.phone('/api/remote/me')
    expect(api.headers['x-frame-options']).toBe('DENY')
  }, 20_000)

  it('refuses a preview origin on control APIs and sends no CORS headers', async () => {
    const ctx = await setup()
    const id = await startApp(ctx.s, ctx.root)
    for (const [path, body] of [['/api/threads', undefined], ['/api/phone/preview-tickets', { processId: id }], ['/api/remote/me', undefined]] as const) {
      const r = await ctx.phone(path, body, { origin: PREVIEW })
      expect(r.status).toBe(403)
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
    }
    const control = await ctx.phone('/api/threads', undefined, { origin: CONTROL })
    expect(control.status).toBe(200)
    expect(Object.keys(control.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
  }, 20_000)

  it('treats two device cookies as no sign-in, on the control origin and on previews', async () => {
    const ctx = await setup()
    const id = await startApp(ctx.s, ctx.root)
    const a = await signIn(ctx, id)
    const twice = { cookie: `${ctx.device}; cockpit_device=planted` }
    expect((await ctx.phone('/api/threads', undefined, twice)).status).toBe(400)
    expect((await ctx.phone('/api/phone/preview-tickets', { processId: id }, twice)).status).toBe(400)
    expect((await ctx.phone('/api/threads')).status).toBe(200)
    const preview = await call(a.gw, '/', { headers: { ...a.headers, cookie: `${a.headers.cookie}; cockpit_device=planted` } })
    expect(preview.status).toBe(401)
    expect(preview.body).not.toContain('fixture')
    expect((await call(a.gw, '/', { headers: a.headers })).body).toContain('fixture')
  }, 20_000)
})
