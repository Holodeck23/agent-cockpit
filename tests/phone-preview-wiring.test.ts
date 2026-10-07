import { request, type IncomingHttpHeaders } from 'node:http'
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

const APP = `require('http').createServer((q,s)=>{s.setHeader('content-type','text/plain');s.end('fixture '+q.url+' cookie='+(q.headers.cookie||'none')+' host='+q.headers.host)}).listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port+'/')})`

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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-pv-state-'))
  const web = mkdtempSync(join(tmpdir(), 'cockpit-pv-web-'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Cockpit</title>')
  const launcher: Launcher = (_req, emit) => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
    close: async () => { emit({ kind: 'exit', code: 0 }) } })
  const ts = fakeTailscale()
  server = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
    remote: { tailscale: ts.tailscale, port: 0, previewListenPort: 0 } })
  const s = server
  const local = (path: string, body?: unknown) => call(s.port, path, body === undefined ? {} : json(body))
  expect((await local('/api/remote', { enabled: true })).status).toBe(200)
  const phonePort = s.remote.port()!
  const via = (extra: Record<string, string> = {}) => ({ host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...extra })
  const pairing = JSON.parse((await call(phonePort, '/api/remote/pair', { ...json({ name: 'Pixel' }), headers: via({ 'content-type': 'application/json' }) })).body).data
  await local(`/api/remote/pairings/${pairing.id}`, { approve: true })
  const device = String((await call(phonePort, `/api/remote/pair/${pairing.id}`, { headers: via() })).headers['set-cookie']?.[0]).split(';')[0]!
  const phone = (path: string, body?: unknown, extra: Record<string, string> = {}) => call(phonePort, path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: via({ cookie: device, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: CONTROL }), ...extra }),
  })
  return { s, root, ts, local, phone, device, phonePort, via }
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
