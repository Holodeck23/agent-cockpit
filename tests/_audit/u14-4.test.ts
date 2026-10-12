import { mkdtempSync } from 'node:fs'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessInfo, ProcessRunner } from '../../server/processes/runner.ts'
import { createPhonePreviews, type PhonePreviews } from '../../server/remote/preview/control.ts'
import type { RemoteStore } from '../../server/remote/store.ts'
import type { Tailscale } from '../../server/remote/tailscale.ts'

// u14-4: two worktrees of one project can run the same-named, same-command dev server at once.
// They share one preview service, and the gateway serves the newest. A ticket must not be issued
// for the older one only to be refused at the bootstrap as "no longer valid".

const HOST = 'mac.tail.ts.net'
const CONTROL = `https://${HOST}`
const DEVICE = 'device-token'
const COMMAND = 'npm run dev'
const base = { name: 'dev', command: COMMAND, projectPath: '/p', exitCode: null, signal: null, owner: { kind: 'user' }, startedAt: '' } as const
const older: ProcessInfo = { ...base, id: 'p1', cwd: '/p-a', pid: 111, status: 'running', url: 'http://localhost:5173/' } as ProcessInfo
const newer: ProcessInfo = { ...base, id: 'p2', cwd: '/p-b', pid: 222, status: 'running', url: 'http://localhost:5174/' } as ProcessInfo

let previews: PhonePreviews | undefined
afterEach(async () => { await previews?.dispose(); previews = undefined })

async function setup() {
  const table = new Map<number, string>()
  const tailscale: Tailscale = {
    self: async () => ({ hostname: HOST, login: 'me@x' }),
    serveTarget: async (_host, httpsPort) => table.get(httpsPort),
    serve: async (port, httpsPort) => { table.set(httpsPort, `http://127.0.0.1:${port}`) },
    unserve: async (httpsPort) => { table.delete(httpsPort) },
  }
  const running = [newer, older] // newest first, like the runner's list
  const processes = {
    list: (projectPath?: string) => running.filter((p) => projectPath === undefined || p.projectPath === projectPath),
    get: (id: string) => running.find((p) => p.id === id),
    subscribe: () => () => undefined,
  } as unknown as ProcessRunner
  const remoteStore = {
    read: () => ({ httpsPort: 443, port: 47000 }),
    deviceFor: (token: string | undefined) => (token === DEVICE ? { id: 'd1' } : undefined),
  } as unknown as RemoteStore
  previews = createPhonePreviews({
    root: mkdtempSync(join(tmpdir(), 'cockpit-u14-4-')), remoteStore, tailscale, processes,
    policy: () => ({ hostname: HOST, allowedLogins: ['me@x'], controlOrigin: CONTROL }),
    listenPort: () => 0,
    listenerGroups: async (port) => (port === 5173 ? [111] : port === 5174 ? [222] : []),
  })
  const service = previews.services.ensure({ projectPath: '/p', name: 'dev', command: COMMAND })
  const res = { writeHead: () => res, end: () => res } as unknown as ServerResponse
  await previews.handleLocal({ method: 'POST' } as IncomingMessage, res, ['api', 'phone', 'previews', service.id, 'serve'])
  const listenPort = (await previews.status()).services[0]!.serve.listenPort
  return { previews, listenPort }
}

function bootstrap(port: number, ticket: string): Promise<{ status: number; state?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/__cockpit/bootstrap', method: 'POST', agent: false, headers: {
      host: `${HOST}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=${DEVICE}`,
      origin: CONTROL, 'content-type': 'application/x-www-form-urlencoded',
    } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, state: String(res.headers['x-cockpit-preview'] ?? '') }) })
    req.on('error', reject)
    req.end(`ticket=${ticket}`)
  })
}

describe('u14-4 a ticket is only issued for the process the gateway serves', () => {
  it('the older of two same-identity processes gets no ticket that the bootstrap would refuse', async () => {
    const { previews: p, listenPort } = await setup()
    const forOlder = await p.ticket({ deviceId: 'd1', login: 'me@x', processId: 'p1' })
    if ('ticket' in forOlder) expect((await bootstrap(listenPort, forOlder.ticket)).status).toBe(303)
    else expect(forOlder.error).toBeTruthy()
    expect('ticket' in forOlder).toBe(false)
  })

  it('the newest one opens normally', async () => {
    const { previews: p, listenPort } = await setup()
    const forNewer = await p.ticket({ deviceId: 'd1', login: 'me@x', processId: 'p2' })
    expect('ticket' in forNewer).toBe(true)
    if ('ticket' in forNewer) expect((await bootstrap(listenPort, forNewer.ticket)).status).toBe(303)
  })
})
