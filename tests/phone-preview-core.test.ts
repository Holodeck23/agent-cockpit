import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPreviewAccess, SESSION_IDLE_MS, TICKET_MS, type Grant } from '../server/remote/preview/access.ts'
import { createPreviewServiceStore, PreviewCapacityError, PreviewStoreError, slotPorts } from '../server/remote/preview/services.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'cockpit-previews-'))
const dev = (n: number) => ({ projectPath: '/p', name: `app ${n}`, command: `npm run dev -- --port ${5000 + n}` })

describe('preview services (W11.1)', () => {
  it('gives one identity one slot, kept across restarts of Cockpit', () => {
    const root = dir()
    const store = createPreviewServiceStore(root)
    const a = store.ensure(dev(1))
    expect(store.ensure(dev(1))).toEqual(a)
    expect(slotPorts(a.slot)).toEqual({ httpsPort: 8443, listenPort: 47822 })
    expect(createPreviewServiceStore(root).find(dev(1))?.id).toBe(a.id)
    expect(readFileSync(join(root, 'phone-previews.json'), 'utf8')).not.toContain('npm run dev')
  })

  it('treats another command under the same name as another service', () => {
    const store = createPreviewServiceStore(dir())
    const a = store.ensure(dev(1))
    const b = store.ensure({ ...dev(1), command: 'python3 -m http.server' })
    expect(b.id).not.toBe(a.id)
    expect(b.slot).not.toBe(a.slot)
  })

  it('skips ports the control listener uses', () => {
    const store = createPreviewServiceStore(dir(), { httpsPorts: [8443], listenPorts: [47823] })
    expect(store.ensure(dev(1)).slot).toBe(2)
    expect(store.ensure(dev(2)).slot).toBe(3)
  })

  it('stops at sixteen and never reuses a retired origin', () => {
    const store = createPreviewServiceStore(dir())
    for (let i = 0; i < 16; i++) store.ensure(dev(i))
    expect(() => store.ensure(dev(99))).toThrow(PreviewCapacityError)
    expect(store.retireProject('/p')).toHaveLength(16)
    expect(store.find(dev(1))).toBeUndefined()
    expect(() => store.ensure(dev(1))).toThrow(PreviewCapacityError)
  })

  it('leaves an unreadable file as found and assigns nothing', () => {
    const root = dir()
    writeFileSync(join(root, 'phone-previews.json'), '{ not json')
    const store = createPreviewServiceStore(root)
    expect(store.damaged).toMatch(/could not be read/)
    expect(() => store.ensure(dev(1))).toThrow(PreviewStoreError)
    expect(readFileSync(join(root, 'phone-previews.json'), 'utf8')).toBe('{ not json')
  })
})

describe('preview access (W11.2)', () => {
  const grant: Grant = { deviceId: 'd1', login: 'me@x', serviceId: 's1', generation: 'g1', origin: 'https://mac.ts.net:8443' }
  const clock = () => { let t = 1_000; return { now: () => t, advance: (ms: number) => { t += ms } } }

  it('a ticket opens one session, once', () => {
    const access = createPreviewAccess()
    const ticket = access.issue(grant)
    const first = access.redeem(ticket, grant)
    expect('session' in first && first.session.serviceId).toBe('s1')
    expect(access.redeem(ticket, grant)).toEqual({ refused: 'unknown' })
  })

  it('refuses an expired ticket and one used anywhere but its own phone, service, generation or origin', () => {
    const c = clock()
    const access = createPreviewAccess(c.now)
    const late = access.issue(grant)
    c.advance(TICKET_MS + 1)
    expect(access.redeem(late, grant)).toEqual({ refused: 'expired' })
    for (const wrong of [{ deviceId: 'd2' }, { login: 'other@x' }, { serviceId: 's2' }, { generation: 'g2' }, { origin: 'https://mac.ts.net:8444' }, { generation: undefined }]) {
      const ticket = access.issue(grant)
      expect(access.redeem(ticket, { ...grant, ...wrong })).toEqual({ refused: 'mismatch' })
      expect(access.redeem(ticket, grant)).toEqual({ refused: 'unknown' })
    }
  })

  it('a session is valid only for its service, login and live generation, and idles out', () => {
    const c = clock()
    const access = createPreviewAccess(c.now)
    const r = access.redeem(access.issue(grant), grant)
    if (!('session' in r)) throw new Error('no session')
    const at = { serviceId: 's1', login: 'me@x', generation: 'g1' }
    expect(access.session(r.session.id, at)?.id).toBe(r.session.id)
    expect(access.session(r.session.id, { ...at, serviceId: 's2' })).toBeUndefined()
    expect(access.session(r.session.id, { ...at, login: 'other@x' })).toBeUndefined()
    c.advance(SESSION_IDLE_MS - 1)
    expect(access.session(r.session.id, at)).toBeDefined()
    c.advance(SESSION_IDLE_MS + 1)
    expect(access.session(r.session.id, at)).toBeUndefined()
  })

  it('a restart ends the old generation and closes what it held; the jar survives', () => {
    const access = createPreviewAccess()
    const r = access.redeem(access.issue(grant), grant)
    if (!('session' in r)) throw new Error('no session')
    r.session.jar.set('sid', { value: 'signed-in', path: '/' })
    let closed = 0
    access.hold(r.session.id, { destroy: () => { closed++ } })
    expect(access.retireGenerations('s1', 'g2')).toBe(1)
    expect(closed).toBe(1)
    expect(access.session(r.session.id, { serviceId: 's1', login: 'me@x', generation: 'g1' })).toBeUndefined()
    const next = access.redeem(access.issue({ ...grant, generation: 'g2' }), { ...grant, generation: 'g2' })
    expect('session' in next && next.session.jar.get('sid')?.value).toBe('signed-in')
  })

  it('revoking a phone ends its sessions, sockets, tickets and jars', () => {
    const access = createPreviewAccess()
    const r = access.redeem(access.issue(grant), grant)
    if (!('session' in r)) throw new Error('no session')
    r.session.jar.set('sid', { value: 'x', path: '/' })
    let closed = false
    access.hold(r.session.id, { destroy: () => { closed = true } })
    const pending = access.issue(grant)
    expect(access.revoke({ deviceId: 'd1' })).toBe(1)
    expect(closed).toBe(true)
    expect(access.redeem(pending, grant)).toEqual({ refused: 'unknown' })
    const again = access.redeem(access.issue(grant), grant)
    expect('session' in again && again.session.jar.size).toBe(0)
  })

  it('holding on an ended session closes at once', () => {
    const access = createPreviewAccess()
    let closed = false
    access.hold('gone', { destroy: () => { closed = true } })
    expect(closed).toBe(true)
  })
})

describe('preview cookie jar (W11.2)', () => {
  it('keeps path and expiry rules', async () => {
    const { absorb, cookieHeader } = await import('../server/remote/preview/jar.ts')
    const jar = new Map()
    absorb(jar, ['sid=abc; Path=/; HttpOnly', 'admin=1; Path=/admin', 'short=1; Path=/; Max-Age=10', 'gone=1; Max-Age=0', 'rel=1'], '/account/login', 1_000)
    expect(cookieHeader(jar, '/', 1_000)).toBe('sid=abc; short=1')
    expect(cookieHeader(jar, '/admin/users', 1_000)).toBe('admin=1; sid=abc; short=1')
    expect(cookieHeader(jar, '/administrator', 1_000)).toBe('sid=abc; short=1')
    expect(cookieHeader(jar, '/account/x', 1_000)).toContain('rel=1')
    expect(cookieHeader(jar, '/', 20_000)).toBe('sid=abc')
    absorb(jar, 'sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/', '/', 20_000)
    expect(cookieHeader(jar, '/', 20_000)).toBeUndefined()
  })
})

describe('preview upstream (SEC-05, SEC-06)', () => {
  it('forwards only to the loopback URL the process printed', async () => {
    const { loopbackTarget } = await import('../server/remote/preview/upstream.ts')
    expect(loopbackTarget('http://localhost:5173/')).toEqual({ hostname: 'localhost', port: 5173, host: 'localhost:5173' })
    expect(loopbackTarget('http://[::1]:3000')).toEqual({ hostname: '::1', port: 3000, host: '[::1]:3000' })
    for (const bad of ['http://192.168.1.5:3000', 'https://localhost:5173', 'http://user:pw@localhost:1', 'http://evil.com:80', 'file:///etc/passwd', 'not a url', undefined]) {
      expect(loopbackTarget(bad)).toBeUndefined()
    }
  })

  it('a process is live only while its own group holds the port', async () => {
    const { createUpstreamResolver } = await import('../server/remote/preview/upstream.ts')
    let groups: number[] = [4242]
    let t = 0
    const resolver = createUpstreamResolver(async () => groups, () => t)
    const proc = { id: 'p1', name: 'dev', command: 'npm run dev', projectPath: '/p', cwd: '/p', status: 'running', pid: 4242, startedAt: '', exitCode: null, signal: null,
      url: 'http://localhost:5173/', owner: { kind: 'user' } } as const
    expect((await resolver.resolve(proc))?.generation).toBe('p1')
    groups = [9999]
    t += 1001
    expect(await resolver.resolve(proc)).toBeUndefined()
    expect(await resolver.resolve({ ...proc, status: 'exited' })).toBeUndefined()
    expect(await resolver.resolve(undefined)).toBeUndefined()
  })
})
