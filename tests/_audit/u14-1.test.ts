import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cookieValues } from '../../server/remote/guard.ts'
import { createPreviewAccess, type PreviewAccess } from '../../server/remote/preview/access.ts'
import { createPreviewGateway, type PreviewGateway } from '../../server/remote/preview/gateway.ts'
import type { PreviewService } from '../../server/remote/preview/services.ts'

// u14-1: a request admitted before access ends must not reach the dev server once its body has
// arrived and the session is gone (phone removed, run restarted).

const HOSTNAME = 'mac.tail.ts.net'
const ORIGIN = `https://${HOSTNAME}:8443`
const service: PreviewService = { id: 'svc-a', slot: 0, projectPath: '/p', name: 'dev', commandHash: '0'.repeat(64), createdAt: '' }
const DEVICE = 'device-token'
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

let app: Server
let hits: string[]
let gateway: PreviewGateway
let access: PreviewAccess
let port = 0
let admitted: Promise<void>
let markAdmitted: () => void

beforeEach(async () => {
  hits = []
  admitted = new Promise((resolve) => { markAdmitted = resolve })
  const stored = createPreviewAccess()
  access = {
    ...stored,
    session(id, at) {
      const found = stored.session(id, at)
      if (found) markAdmitted()
      return found
    },
  }
  app = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); req.resume(); req.on('end', () => res.end('stored')) })
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

/** A POST whose body is split in two: the first half is sent, `between` runs, then the rest. */
async function splitUpload(between: () => void): Promise<{ status?: number; error?: string }> {
  const id = session()
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/upload', method: 'POST', agent: false, headers: {
      host: `${HOSTNAME}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=${DEVICE}; cockpit_pv_0=${id}`,
      'content-length': '10', origin: ORIGIN,
    } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })) })
    req.on('error', (error) => resolve({ error: error.message }))
    req.write('12345')
    void (async () => {
      // The case under test is a request that passed admission, then lost access while its body
      // was still arriving. Waiting for the session lookup makes that ordering deterministic even
      // on a loaded CI runner; a fixed sleep could revoke first and merely exercise the 401 path.
      await admitted
      between()
      await settle(50)
      req.end('67890')
    })()
  })
}

describe('u14-1 a revoked session does not forward an in-flight request', () => {
  it('removing the phone while its upload is arriving keeps the upload from the dev server', async () => {
    const outcome = await splitUpload(() => { expect(access.revoke({ deviceId: 'd1' })).toBe(1) })
    await settle()
    expect(hits).toEqual([])
    expect(outcome.status).toBeUndefined()
  })

  it('a restart (new generation) while an upload is arriving keeps it from the new process', async () => {
    await splitUpload(() => { expect(access.retireGenerations(service.id, 'g2')).toBe(1) })
    await settle()
    expect(hits).toEqual([])
  })

  it('an upload whose session stays valid is still forwarded', async () => {
    const outcome = await splitUpload(() => undefined)
    expect(outcome.status).toBe(200)
    expect(hits).toEqual(['POST /upload'])
  })
})
