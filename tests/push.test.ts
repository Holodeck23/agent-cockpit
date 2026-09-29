import { request } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PushSender, PushSubscription } from '../server/remote/push.ts'
import type { Tailscale } from '../server/remote/tailscale.ts'
import { startServer } from '../server/start.ts'
import type { EventSink } from '../server/agents/types.ts'
import type { Launcher } from '../server/threads/manager.ts'

const HOST = 'mac.example.ts.net'
const OWNER = 'owner@example.com'

interface Reply { status: number; body: string; cookie?: string }
function call(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET',
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

const subscription = (n: number): PushSubscription =>
  ({ endpoint: `https://push.example/send/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } })

async function setup(pushStatus = 201) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-push-'))
  const web = mkdtempSync(join(tmpdir(), 'cockpit-push-web-'))
  writeFileSync(join(web, 'index.html'), '<!doctype html>')
  const project = join(root, 'bakery-website'); mkdirSync(project)
  const emits: EventSink[] = []
  // A fake agent that asks for approval on every turn, as a real one does before running a command.
  const launcher: Launcher = (_req, emit) => {
    emits.push(emit)
    return { agent: 'claude', alive: () => true, respondApproval() {}, interrupt() {},
      send: () => { emit({ kind: 'approval_request', requestId: `r${emits.length}`, toolName: 'Bash', input: { command: 'npm test' }, suggestions: [] }) },
      close: async () => { emit({ kind: 'exit', code: 0 }) } }
  }
  const sent: { endpoint: string; payload: string }[] = []
  const sendPush: PushSender = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload }); return pushStatus }
  let target: string | undefined
  const tailscale: Tailscale = { self: async () => ({ hostname: HOST, login: OWNER }), serveTarget: async () => target,
    serve: async (port) => { target = `http://127.0.0.1:${port}` }, unserve: async () => { target = undefined } }
  const server = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
    remote: { tailscale, port: 0, sendPush } })
  const local = (path: string, body?: unknown) => call(server.port, path, body === undefined ? {} : { method: 'POST', body })
  await local('/api/remote', { enabled: true })
  const phonePort = server.remote.port()!
  const tailnet = { host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER }
  const pair = async (): Promise<string> => {
    const request_ = data(await call(phonePort, '/api/remote/pair', { method: 'POST', body: { name: `Phone ${Math.random()}` }, headers: tailnet }))
    await local(`/api/remote/pairings/${request_.id}`, { approve: true })
    return (await call(phonePort, `/api/remote/pair/${request_.id}`, { headers: tailnet })).cookie!.split(';')[0]!
  }
  const phone = (cookie: string, path: string, body?: unknown) =>
    call(phonePort, path, { ...(body === undefined ? {} : { method: 'POST', body }), headers: { ...tailnet, cookie } })
  return { server, local, pair, phone, sent, project }
}

describe('needs-you notifications', () => {
  it('notifies each subscribed, paired phone once per approval request, with the project and title', async () => {
    const { server, local, pair, phone, sent, project } = await setup()
    try {
      const first = await pair()
      const second = await pair()
      expect(data(await phone(first, '/api/remote/push/key')).publicKey).toMatch(/^[\w-]{80,}$/)
      expect((await phone(first, '/api/remote/push/subscribe', { subscription: subscription(1) })).status).toBe(200)
      expect((await phone(second, '/api/remote/push/subscribe', { subscription: subscription(2) })).status).toBe(200)
      expect(data(await phone(first, '/api/remote/me')).notifications).toBe(true)
      expect(data(await local('/api/remote')).devices.map((d: { notifications: boolean }) => d.notifications)).toEqual([true, true])

      const created = await local('/api/threads', { projectPath: project, text: 'Run the tests' })
      const threadId = data(created).id
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/send/1', 'https://push.example/send/2'])
      expect(JSON.parse(sent[0]!.payload)).toEqual({ title: 'Needs you', body: 'bakery-website: Run the tests', threadId })

      // Unsubscribing and removing a phone both stop its notifications.
      await phone(second, '/api/remote/push/unsubscribe', {})
      const device = data(await local('/api/remote')).devices[0].id
      await local(`/api/remote/devices/${device}/revoke`, {})
      sent.length = 0
      await local(`/api/threads/${threadId}/messages`, { text: 'Again' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sent).toEqual([])
    } finally { await server.close() }
  })

  it('stays quiet while phone access is off and drops subscriptions the push service says are gone', async () => {
    const { server, local, pair, phone, sent, project } = await setup(410)
    try {
      const cookie = await pair()
      await phone(cookie, '/api/remote/push/subscribe', { subscription: subscription(1) })
      await local('/api/remote', { enabled: false })
      await local('/api/threads', { projectPath: project, text: 'While off' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sent).toEqual([])
      await local('/api/remote', { enabled: true })
      await local('/api/threads', { projectPath: project, text: 'Back on' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(sent).toHaveLength(1)
      expect(data(await local('/api/remote')).devices[0].notifications).toBe(false)
    } finally { await server.close() }
  })

  it('refuses subscriptions from unpaired phones and non-HTTPS endpoints', async () => {
    const { server, pair, phone } = await setup()
    try {
      expect((await phone('cockpit_device=nope', '/api/remote/push/subscribe', { subscription: subscription(1) })).status).toBe(401)
      const cookie = await pair()
      const insecure = { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }
      expect((await phone(cookie, '/api/remote/push/subscribe', { subscription: insecure })).status).toBe(400)
    } finally { await server.close() }
  })
})
