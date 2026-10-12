import { request } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubEvent } from '../electron/telemetry-choice.ts'
import { createPrivacy, privateRoots, scrubPrivate } from '../server/projects/privacy.ts'
import type { PushSender } from '../server/remote/push.ts'
import { ROUTES } from '../server/remote/routes.ts'
import type { Tailscale } from '../server/remote/tailscale.ts'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'
import type { ProjectMap } from '../server/projects/map.ts'

// Mac only (projects-area Move 9): nothing from a Mac-only project reaches the phone, through ANY
// phone route, the live stream or a push notification. Every entry of ROUTES is called from a paired
// phone; a route added later without the filter fails here.

const HOST = 'mac.example.ts.net'
const OWNER = 'owner@example.com'
const SECRET = { folder: 'secret-garden', title: 'Plant the walnut grove', word: 'walnut' }

interface Reply { status: number; body: string; cookie?: string }
function call(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    // A fresh connection each time: the phone listener refuses a route without reading its body, which ends that connection.
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', agent: false,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, cookie: res.headers['set-cookie']?.[0] }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
const data = (reply: Reply) => JSON.parse(reply.body).data
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const leaks = (text: string, secretPath: string): string[] =>
  [secretPath, SECRET.folder, SECRET.title, SECRET.word].filter((s) => text.toLowerCase().includes(s.toLowerCase()))

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-privacy-'))
  const web = mkdtempSync(join(tmpdir(), 'cockpit-privacy-web-'))
  writeFileSync(join(web, 'index.html'), '<!doctype html>')
  const library = mkdtempSync(join(tmpdir(), 'cockpit-privacy-lib-'))
  const secret = join(library, 'home', SECRET.folder); mkdirSync(secret, { recursive: true })
  const visible = join(root, 'bakery-website'); mkdirSync(visible)
  const launcher: Launcher = (_req, emit) => ({ agent: 'claude', alive: () => true, respondApproval() {}, interrupt() {},
    send: (text: string) => {
      emit({ kind: 'assistant_text', messageId: `m${Math.random()}`, text: `Thinking about ${text}` })
      emit({ kind: 'approval_request', requestId: `r${Math.random()}`, toolName: 'Bash', input: { command: 'ls' }, suggestions: [] })
    },
    close: async () => { emit({ kind: 'exit', code: 0 }) } })
  const sent: string[] = []
  const sendPush: PushSender = async (_sub, payload) => { sent.push(payload); return 201 }
  let target: string | undefined
  const tailscale: Tailscale = { self: async () => ({ hostname: HOST, login: OWNER }), serveTarget: async () => target,
    serve: async (port) => { target = `http://127.0.0.1:${port}` }, unserve: async () => { target = undefined } }
  const server = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
    remote: { tailscale, port: 0, sendPush } })
  const local = (path: string, body?: unknown) => call(server.port, path, body === undefined ? {} : { method: 'POST', body })
  await local('/api/remote', { enabled: true })
  const phonePort = server.remote.port()!
  const tailnet = { host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER }
  const pairing = data(await call(phonePort, '/api/remote/pair', { method: 'POST', body: { name: 'Pixel' }, headers: tailnet }))
  await local(`/api/remote/pairings/${pairing.id}`, { approve: true })
  const cookie = (await call(phonePort, `/api/remote/pair/${pairing.id}`, { headers: tailnet })).cookie!.split(';')[0]!
  const phone = (method: string, path: string, body?: unknown) =>
    call(phonePort, path, { method, ...(body === undefined ? {} : { body }), headers: { ...tailnet, cookie } })
  return { server, local, phone, phonePort, tailnet, cookie, sent, library, secret, visible }
}

describe('Mac only on the phone', () => {
  it('no phone route returns anything from a Mac-only project; the visible project still shows', async () => {
    const s = await setup()
    try {
      // The library is Mac only; both projects are open in Cockpit with a conversation each.
      expect((await s.local('/api/navigation', { op: 'addLibrary', root: s.library, private: true })).status).toBe(200)
      await s.local('/api/projects', { path: s.secret, pinned: true })
      await s.local('/api/projects', { path: s.visible, pinned: true })
      const secretThread = data(await s.local('/api/threads', { projectPath: s.secret, text: SECRET.title })).id as string
      const visibleThread = data(await s.local('/api/threads', { projectPath: s.visible, text: 'Run the tests' })).id as string
      s.server.processes.start({ projectPath: s.secret, command: 'sleep 30', name: `${SECRET.word}-server` })
      s.server.processes.start({ projectPath: s.visible, command: 'sleep 30', name: 'bakery-server' })
      await settle()

      // Positive controls: the phone is paired and sees the visible project.
      const threads = await s.phone('GET', '/api/threads')
      expect(threads.status).toBe(200)
      expect(data(threads).map((t: { meta: { id: string } }) => t.meta.id)).toEqual([visibleThread])
      expect((await s.phone('GET', `/api/threads/${visibleThread}/events`)).status).toBe(200)
      expect(data(await s.phone('GET', '/api/projects')).map((p: { path: string }) => p.path)).toEqual([s.visible])
      expect(data(await s.phone('GET', '/api/processes')).map((p: { name: string }) => p.name)).toEqual(['bakery-server'])
      // The desktop still sees both.
      expect(data(await s.local('/api/threads'))).toHaveLength(2)

      const fill = (route: string): string => route
        .replace(/^threads\/:id/, `threads/${secretThread}`)
        .replace(':agent', 'claude').replace(':requestId', 'r1').replace(':file', 'a.png').replace(':queuedId', 'q1')
        .replace(':evidenceId', 'e1').replace(/:id/g, 'x1')
      const query = (route: string): string => ({
        threads: '', 'threads/search': `?q=${SECRET.word}`, processes: `?project=${encodeURIComponent(s.secret)}`,
        'runs/:id/result': `?threadId=${secretThread}`, git: `?projectPath=${encodeURIComponent(s.secret)}`,
      } as Record<string, string>)[route] ?? ''
      const covered: string[] = []
      for (const r of ROUTES) {
        if (r.route === 'stream') continue // below
        const path = `/api/${fill(r.route)}${query(r.route)}`
        const body = r.method === 'GET' ? undefined : { text: `hello ${SECRET.word}`, threadId: secretThread, projectPath: s.secret, processId: 'x1', decision: 'allow' }
        const reply = await s.phone(r.method, path, body).catch((error: unknown) => { throw new Error(`${r.method} ${path}: ${String(error)}`) })
        expect(leaks(reply.body, s.secret), `${r.method} ${r.route} → ${reply.status}`).toEqual([])
        if (!r.phone) expect(reply.status, `${r.method} ${r.route}`).toBe(403)
        if (r.phone && r.route.startsWith('threads/:id')) expect(reply.status, `${r.method} ${r.route}`).toBe(404)
        covered.push(`${r.method} ${r.route}`)
      }
      expect(covered).toHaveLength(ROUTES.length - 1)
      // The phone's message to the Mac-only conversation was refused, not delivered.
      const events = data(await s.local(`/api/threads/${secretThread}/events`)).events as Array<{ event: { kind: string; text?: string } }>
      expect(events.some((e) => e.event.kind === 'user_text' && e.event.text?.startsWith('hello'))).toBe(false)
      // Not on the phone at all: the Map and arranging.
      expect((await s.phone('GET', '/api/map')).status).toBe(403)
    } finally { await s.server.close() }
  })

  it('the live stream to the phone carries no frame from a Mac-only conversation or process', async () => {
    const s = await setup()
    try {
      await s.local('/api/navigation', { op: 'addLibrary', root: s.library, private: true })
      await s.local('/api/projects', { path: s.secret, pinned: true })
      await s.local('/api/projects', { path: s.visible, pinned: true })
      const secretThread = data(await s.local('/api/threads', { projectPath: s.secret, text: 'first' })).id as string
      const visibleThread = data(await s.local('/api/threads', { projectPath: s.visible, text: 'first' })).id as string
      await settle()
      let frames = ''
      const stream = request({ host: '127.0.0.1', port: s.phonePort, path: '/api/stream', headers: { ...s.tailnet, cookie: s.cookie } }, (res) => {
        res.on('data', (chunk) => { frames += chunk })
      })
      stream.end()
      await settle(100)
      await s.local(`/api/threads/${secretThread}/messages`, { text: SECRET.title })
      await s.local(`/api/threads/${visibleThread}/messages`, { text: 'Run the tests again' })
      s.server.processes.start({ projectPath: s.secret, command: 'sleep 30', name: `${SECRET.word}-server` })
      s.server.processes.start({ projectPath: s.visible, command: 'sleep 30', name: 'bakery-server' })
      await settle(200)
      stream.destroy()
      expect(frames).toContain(visibleThread)
      expect(frames).toContain('bakery-server')
      expect(frames).not.toContain(secretThread)
      expect(leaks(frames, s.secret)).toEqual([])
    } finally { await s.server.close() }
  })

  it('a question in a Mac-only conversation sends no push; one in a visible conversation does', async () => {
    const s = await setup()
    try {
      await s.local('/api/navigation', { op: 'addLibrary', root: s.library, private: true })
      await s.phone('POST', '/api/remote/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/send/1', keys: { p256dh: 'p', auth: 'a' } } })
      await s.local('/api/threads', { projectPath: s.secret, text: SECRET.title })
      await settle()
      expect(s.sent).toEqual([])
      await s.local('/api/threads', { projectPath: s.visible, text: 'Run the tests' })
      await settle()
      expect(s.sent).toHaveLength(1)
      expect(leaks(s.sent.join(''), s.secret)).toEqual([])
    } finally { await s.server.close() }
  })

  it('marking one project or area Mac only takes effect at once', async () => {
    const s = await setup()
    try {
      await s.local('/api/navigation', { op: 'addLibrary', root: s.library })
      await s.local('/api/projects', { path: s.secret, pinned: true })
      const id = data(await s.local('/api/threads', { projectPath: s.secret, text: SECRET.title })).id as string
      await settle()
      expect(data(await s.phone('GET', '/api/threads'))).toHaveLength(1)
      await s.local('/api/navigation', { op: 'setProjectPrivate', path: s.secret, private: true })
      expect(data(await s.phone('GET', '/api/threads'))).toHaveLength(0)
      expect((await s.phone('GET', `/api/threads/${id}/events`)).status).toBe(404)
      await s.local('/api/navigation', { op: 'setProjectPrivate', path: s.secret, private: false })
      expect(data(await s.phone('GET', '/api/threads'))).toHaveLength(1)
      const area = (data(await s.local('/api/map')).areas as Array<{ id: string; name: string }>).find((a) => a.name === 'home')!
      await s.local('/api/navigation', { op: 'setAreaPrivate', id: area.id, private: true })
      expect(data(await s.phone('GET', '/api/threads'))).toHaveLength(0)
    } finally { await s.server.close() }
  })

  it('a memory saved "everywhere" from a Mac-only project is kept to that project', async () => {
    const s = await setup()
    try {
      await s.local('/api/navigation', { op: 'addLibrary', root: s.library, private: true })
      await s.local('/api/projects', { path: s.secret, pinned: true })
      await s.local('/api/projects', { path: s.visible, pinned: true })
      const kept = data(await s.local('/api/memory', { projectPath: s.secret, scope: 'everywhere', text: 'The walnut grove is north' }))
      expect(kept.scope).toBe('project')
      const shared = data(await s.local('/api/memory', { projectPath: s.visible, scope: 'everywhere', text: 'Use British spelling' }))
      expect(shared.scope).toBe('everywhere')
      const elsewhere = data(await s.local(`/api/memory?projectPath=${encodeURIComponent(s.visible)}`)) as Array<{ text: string }>
      expect(elsewhere.map((m) => m.text)).toEqual(['Use British spelling'])
    } finally { await s.server.close() }
  })
})

describe('Mac only in crash reports and the predicate', () => {
  it('replaces each private folder with <private>, before the home folder becomes ~', () => {
    const home = '/Users/someone'
    const event = { message: `failed reading ${home}/vault/clients/acme/notes.md`, exception: { values: [{ value: '/Volumes/Work/private-lib/x.ts broke' }] } }
    const scrubbed = scrubEvent(event, home, [`${home}/vault`, '/Volumes/Work/private-lib'])
    expect(scrubbed.message).toBe('failed reading <private>/clients/acme/notes.md')
    expect(scrubbed.exception.values[0]!.value).toBe('<private>/x.ts broke')
    expect(scrubEvent(event, home).message).toBe('failed reading ~/vault/clients/acme/notes.md')
    expect(scrubPrivate('/a/b/c and /a/bc', ['/a/b'])).toBe('<private>/c and /a/bc')
  })

  it('private roots come from private libraries, areas and projects, never a whole library through its Loose area', () => {
    const project = (path: string, priv: boolean) => ({ path, openPath: path, name: 'p', children: [], layers: [], known: false, pinned: false, working: 0, needsYou: 0, private: priv })
    const map: ProjectMap = {
      libraries: [{ root: '/lib', private: false, truncated: false }, { root: '/vault', private: true, truncated: false }],
      areas: [
        { id: 'a1', name: 'table', library: '/lib', root: '/lib/table', private: true, shelf: false, hidden: false, collapsed: false, custom: false, projects: [] },
        { id: 'a2', name: 'Loose', library: '/lib', root: '/lib', private: true, shelf: false, hidden: false, collapsed: false, custom: false, projects: [project('/lib/one', true)] },
        { id: 'a3', name: 'apps', library: '/lib', root: '/lib/apps', private: false, shelf: false, hidden: false, collapsed: false, custom: false, projects: [project('/lib/apps/two', false)] },
      ],
    }
    expect(privateRoots(map).sort()).toEqual(['/lib/table', '/lib/one', '/vault'])
    const privacy = createPrivacy(() => privateRoots(map), (p) => p)
    expect(privacy.macOnly('/vault/clients/x')).toBe(true)
    expect(privacy.macOnly('/lib/table/y')).toBe(true)
    expect(privacy.macOnly('/lib/apps/two')).toBe(false)
    expect(privacy.macOnly('/vaulted')).toBe(false)
    expect(privacy.macOnly('')).toBe(false)
  })
})
