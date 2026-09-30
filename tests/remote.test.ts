import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { checkRemote, isRemoteRoute } from '../server/remote/guard.ts'
import { createRemoteStore } from '../server/remote/store.ts'
import type { Tailscale } from '../server/remote/tailscale.ts'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

const HOST = 'mac.example.ts.net'
const OWNER = 'owner@example.com'
const policy = { hostname: HOST, allowedLogins: [OWNER] }

function fakeReq(overrides: { remote?: string; method?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  const headers = { host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...overrides.headers }
  for (const [key, value] of Object.entries(headers)) if (value === '') delete (headers as Record<string, string>)[key]
  return { socket: { remoteAddress: overrides.remote ?? '127.0.0.1' }, method: overrides.method ?? 'GET', headers } as unknown as IncomingMessage
}

describe('phone access guard', () => {
  it('accepts a request that came through tailscale serve from an allowed login (positive control)', () => {
    expect(checkRemote(fakeReq(), policy)).toEqual({ ok: true, login: OWNER })
    expect(checkRemote(fakeReq({ headers: { host: `${HOST}:443`, 'tailscale-user-login': 'OWNER@example.com' } }), policy).ok).toBe(true)
    expect(checkRemote(fakeReq({ method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${HOST}` } }), policy).ok).toBe(true)
  })
  it.each([
    ['a LAN address', { remote: '192.0.2.50' }],
    ['a LAN Host', { headers: { host: '192.0.2.10:47821' } }],
    ['a loopback Host (not via Tailscale)', { headers: { host: '127.0.0.1:47821' } }],
    ['plain HTTP', { headers: { 'x-forwarded-proto': '' } }],
    ['no Tailscale identity (tagged device or Funnel)', { headers: { 'tailscale-user-login': '' } }],
    ['a login not on the allowlist', { headers: { 'tailscale-user-login': 'guest@example.com' } }],
    ['a foreign Origin', { headers: { origin: 'https://evil.example' } }],
    ['an http Origin for the right host', { headers: { origin: `http://${HOST}` } }],
    ['a form post', { method: 'POST', headers: { 'content-type': 'text/plain' } }],
  ])('refuses %s', (_name, overrides) => {
    expect(checkRemote(fakeReq(overrides), policy)).toMatchObject({ ok: false, status: 403 })
  })
  it('expects the port in Host and Origin when Tailscale serves on 8443', () => {
    const on8443 = { ...policy, httpsPort: 8443 }
    expect(checkRemote(fakeReq({ headers: { host: `${HOST}:8443`, origin: `https://${HOST}:8443` } }), on8443).ok).toBe(true)
    expect(checkRemote(fakeReq(), on8443).ok).toBe(false)
    expect(checkRemote(fakeReq({ headers: { host: `${HOST}:8443`, origin: `https://${HOST}` } }), on8443).ok).toBe(false)
  })
  it('refuses everything until this Mac knows its tailnet name', () => {
    expect(checkRemote(fakeReq(), { hostname: '', allowedLogins: [OWNER] }).ok).toBe(false)
  })
  it('limits the phone to reading, replying, approvals and stop', () => {
    expect(isRemoteRoute('GET', '/api/threads')).toBe(true)
    expect(isRemoteRoute('POST', '/api/threads/abc/approvals/xyz')).toBe(true)
    expect(isRemoteRoute('POST', '/api/threads/abc/messages')).toBe(true)
    for (const [method, path] of [['POST', '/api/threads'], ['POST', '/api/projects'], ['GET', '/api/files'], ['PUT', '/api/files/write'], ['POST', '/api/workflows'],
      ['POST', '/api/processes/p1/stop'], ['POST', '/api/threads/abc/agent'], ['GET', '/api/remote'], ['POST', '/api/mcp/tool']]) {
      expect(isRemoteRoute(method!, path!)).toBe(false)
    }
  })
})

describe('pairing store', () => {
  it('redeems an approved request once, binds the token to the login, and expires requests', () => {
    let clock = 1_000_000
    const store = createRemoteStore(mkdtempSync(join(tmpdir(), 'cockpit-remote-')), () => clock)
    const request = store.requestPairing('Pixel', OWNER)
    expect(request.code).toMatch(/^\d{6}$/)
    expect(store.redeem(request.id, OWNER)).toEqual({ status: 'pending' })
    expect(store.redeem(request.id, 'guest@example.com')).toBeUndefined()
    store.decide(request.id, true)
    const { token } = store.redeem(request.id, OWNER)!
    expect(token).toBeTruthy()
    expect(store.redeem(request.id, OWNER)).toBeUndefined()
    expect(store.deviceFor(token, OWNER)?.name).toBe('Pixel')
    expect(store.deviceFor(token, 'guest@example.com')).toBeUndefined()
    expect(JSON.stringify(store.read())).not.toContain(token!)
    const again = store.requestPairing('Pixel 9a', OWNER)
    expect(store.requestPairing('Pixel 9a', OWNER)).toEqual(again)
    for (let i = 0; i < 10; i += 1) store.requestPairing('Pixel 9a', OWNER)
    expect(store.pendingPairings()).toHaveLength(1)
    store.decide(again.id, false)
    const late = store.requestPairing('Other', OWNER)
    clock += 6 * 60_000
    expect(() => store.decide(late.id, true)).toThrow(/expired/)
  })
})

interface Reply { status: number; body: string; cookie?: string }
function call(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    const req = request({ host: init.host ?? '127.0.0.1', port, path, method: init.method ?? 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, cookie: res.headers['set-cookie']?.[0] }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function fakeTailscale(existingTarget?: string) {
  const calls: string[] = []
  let target = existingTarget
  const tailscale: Tailscale = {
    self: async () => ({ hostname: HOST, login: OWNER }),
    serveTarget: async () => target,
    serve: async (port, httpsPort) => { calls.push(`serve ${port} on ${httpsPort}`); target = `http://127.0.0.1:${port}` },
    unserve: async (httpsPort) => { calls.push(`unserve ${httpsPort}`); target = undefined },
  }
  return { tailscale, calls }
}

async function setup(existingTarget?: string) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-remote-state-'))
  const web = mkdtempSync(join(tmpdir(), 'cockpit-remote-web-'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Cockpit</title>')
  const launcher: Launcher = (_req, emit) => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
    close: async () => { emit({ kind: 'exit', code: 0 }) } })
  const ts = fakeTailscale(existingTarget)
  const server = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
    remote: { tailscale: ts.tailscale, port: 0 } })
  const local = (path: string, body?: unknown) => call(server.port, path, body === undefined ? {} : { method: 'POST', body })
  return { server, ts, local, root }
}

const viaTailscale = (extra: Record<string, string> = {}) =>
  ({ host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER, ...extra })

describe('phone access over HTTP', () => {
  it('pairs a phone, serves only the phone routes, and refuses every other path', async () => {
    const { server, ts, local } = await setup()
    try {
      expect(server.remote.port()).toBeUndefined()
      const enabled = JSON.parse((await local('/api/remote', { enabled: true })).body).data
      expect(enabled).toMatchObject({ enabled: true, running: true, url: `https://${HOST}`, allowedLogins: [OWNER] })
      const port = server.remote.port()!
      expect(ts.calls).toEqual([`serve ${port} on 443`])
      const phone = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
        call(port, path, { ...init, headers: viaTailscale(init.headers) })

      // Positive control first: the listener answers, so the refusals below are real refusals.
      expect((await phone('/')).status).toBe(200)
      expect(JSON.parse((await phone('/api/remote/me')).body).data).toEqual({ mode: 'remote', login: OWNER, paired: false, notifications: false })
      // Negative controls against the live listener.
      expect((await call(port, '/api/threads')).status).toBe(403)
      expect((await call(port, '/', { headers: { host: '127.0.0.1' } })).status).toBe(403)
      expect((await phone('/api/threads', { headers: { 'tailscale-user-login': 'guest@example.com' } })).status).toBe(403)
      expect((await phone('/api/threads', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
      expect((await phone('/api/threads', { headers: { 'x-forwarded-proto': 'http' } })).status).toBe(403)
      expect((await phone('/api/threads')).status).toBe(401)
      // The desktop listener still refuses the tailnet Host.
      expect((await call(server.port, '/api/threads', { headers: { host: HOST } })).status).toBe(403)

      const pair = JSON.parse((await phone('/api/remote/pair', { method: 'POST', body: { name: 'Pixel 9a' } })).body).data
      const status = JSON.parse((await local('/api/remote')).body).data
      expect(status.pairings).toEqual([{ id: pair.id, code: pair.code, name: 'Pixel 9a', login: OWNER }])
      expect(JSON.parse((await phone(`/api/remote/pair/${pair.id}`)).body).data.status).toBe('pending')
      await local(`/api/remote/pairings/${pair.id}`, { approve: true })
      const redeemed = await phone(`/api/remote/pair/${pair.id}`)
      expect(redeemed.cookie).toMatch(/^cockpit_device=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict/)
      expect((await phone(`/api/remote/pair/${pair.id}`)).status).toBe(404)
      const cookie = redeemed.cookie!.split(';')[0]!

      const paired = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
        phone(path, { ...init, headers: { cookie, ...init.headers } })
      expect((await paired('/api/threads')).status).toBe(200)
      expect(JSON.parse((await paired('/api/remote/me')).body).data.paired).toBe(true)
      for (const [method, path, body] of [['POST', '/api/threads', { projectPath: '/tmp', text: 'hi' }], ['GET', '/api/files?projectPath=/tmp'],
        ['POST', '/api/remote', { enabled: false }], ['POST', '/api/projects', { path: '/tmp' }]] as const) {
        expect((await paired(path, { method, ...(body ? { body } : {}) })).status).toBe(403)
      }
      // The token is bound to the login that paired it.
      expect((await paired('/api/threads', { headers: { 'tailscale-user-login': 'OTHER@example.com' } })).status).toBe(403)

      const device = JSON.parse((await local('/api/remote')).body).data.devices[0]
      expect(device).toMatchObject({ name: 'Pixel 9a', login: OWNER })
      expect(device.tokenHash).toBeUndefined()
      await local(`/api/remote/devices/${device.id}/revoke`, {})
      expect((await paired('/api/threads')).status).toBe(401)

      const off = JSON.parse((await local('/api/remote', { enabled: false })).body).data
      expect(off).toMatchObject({ enabled: false, running: false })
      expect(ts.calls).toEqual([`serve ${port} on 443`, 'unserve 443'])
      await expect(call(port, '/')).rejects.toThrow(/ECONNREFUSED/)
    } finally { await server.close() }
  })

  it('is unreachable from the LAN address because it binds loopback only', async () => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal && !i.address.startsWith('100.'))?.address
    if (!lan) return
    // Closed LAN ports may hang rather than refuse (firewall stealth mode), so "reachable" means a TCP connect within 1.5 s.
    const reachable = (host: string, port: number) => new Promise<boolean>((resolve) => {
      const socket = connect({ host, port })
      const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
      socket.setTimeout(1500, () => done(false))
      socket.on('connect', () => done(true))
      socket.on('error', () => done(false))
    })
    // Control: a listener on every interface IS reachable on the LAN address, so a false below is a real refusal.
    const open = createServer().listen(0, '0.0.0.0')
    await new Promise((resolve) => open.once('listening', resolve))
    const openPort = (open.address() as { port: number }).port
    const { server, local } = await setup()
    try {
      expect(await reachable(lan, openPort)).toBe(true)
      await local('/api/remote', { enabled: true })
      const port = server.remote.port()!
      expect(await reachable('127.0.0.1', port)).toBe(true)
      expect(await reachable(lan, port)).toBe(false)
    } finally { open.close(); await server.close() }
  })

  it('will not take over an HTTPS address that already serves something else', async () => {
    const { server, ts, local } = await setup('http://127.0.0.1:3000')
    try {
      const res = await local('/api/remote', { enabled: true })
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/already goes to http:\/\/127\.0\.0\.1:3000/)
      expect(server.remote.port()).toBeUndefined()
      expect(ts.calls).toEqual([])
    } finally { await server.close() }
  })
})
