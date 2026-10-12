import { createServer, request, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cookieValues } from '../../server/remote/guard.ts'
import { createPreviewAccess, type PreviewAccess } from '../../server/remote/preview/access.ts'
import { createPreviewGateway, type PreviewGateway } from '../../server/remote/preview/gateway.ts'
import type { PreviewService } from '../../server/remote/preview/services.ts'

// u14-2: when the phone goes away (or its session is revoked) before the dev server's first byte,
// the upstream request must be torn down, so a stream the dev server starts later is closed.

const HOSTNAME = 'mac.tail.ts.net'
const ORIGIN = `https://${HOSTNAME}:8443`
const service: PreviewService = { id: 'svc-a', slot: 0, projectPath: '/p', name: 'dev', commandHash: '0'.repeat(64), createdAt: '' }
const DEVICE = 'device-token'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let app: Server
let appResponses: ServerResponse[]
let closed: boolean[]
let gateway: PreviewGateway
let access: PreviewAccess
let port = 0

beforeEach(async () => {
  appResponses = []
  closed = []
  access = createPreviewAccess()
  app = createServer((req, res) => {
    const index = appResponses.push(res) - 1
    closed[index] = false
    res.on('close', () => { closed[index] = true })
    // Headers only after a delay (a dev server compiling), then a stream that never ends.
    if (req.url === '/slow-sse') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hello\n\n') }, 300); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hello\n\n')
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
  const appPort = (app.address() as AddressInfo).port
  gateway = createPreviewGateway({
    access,
    policy: () => ({ hostname: HOSTNAME, allowedLogins: ['me@x'], controlOrigin: `https://${HOSTNAME}` }),
    device: (req) => (cookieValues(req, 'cockpit_device')[0] === DEVICE ? 'd1' : undefined),
    upstream: async () => ({ hostname: '127.0.0.1', port: appPort, host: `localhost:${appPort}`, generation: 'g1' }),
    listenPort: () => 0,
  })
  port = await gateway.open(service)
})
afterEach(async () => { await gateway.closeAll(); app.closeAllConnections(); app.close() })

function session(): string {
  const grant = { deviceId: 'd1', login: 'me@x', serviceId: service.id, generation: 'g1', origin: ORIGIN }
  const redeemed = access.redeem(access.issue(grant), grant)
  if (!('session' in redeemed)) throw new Error('no session')
  return redeemed.session.id
}

function open(path: string): { abort: () => void; gotHeaders: Promise<void> } {
  const id = session()
  let resolveHeaders = (): void => undefined
  const gotHeaders = new Promise<void>((resolve) => { resolveHeaders = resolve })
  const req = request({ host: '127.0.0.1', port, path, agent: false, headers: {
    host: `${HOSTNAME}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=${DEVICE}; cockpit_pv_0=${id}`,
  } }, (res) => { res.on('error', () => undefined); res.resume(); resolveHeaders() })
  req.on('error', () => undefined)
  req.end()
  return { abort: () => req.destroy(), gotHeaders }
}

describe('u14-2 the upstream request does not outlive the phone', () => {
  it('a phone that leaves before the first byte does not keep the dev server stream open', async () => {
    const call = open('/slow-sse')
    await sleep(100)
    call.abort()
    await sleep(1500)
    expect(appResponses).toHaveLength(1)
    expect(closed[0]).toBe(true)
  })

  it('a session revoked before the first byte does not keep the dev server stream open', async () => {
    open('/slow-sse')
    await sleep(100)
    expect(access.revoke({ deviceId: 'd1' })).toBe(1)
    await sleep(1500)
    expect(appResponses).toHaveLength(1)
    expect(closed[0]).toBe(true)
  })

  it('a phone that leaves after the headers still closes the stream (control)', async () => {
    const call = open('/sse')
    await call.gotHeaders
    call.abort()
    await sleep(500)
    expect(closed[0]).toBe(true)
  })
})
