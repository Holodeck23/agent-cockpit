import { request, type IncomingHttpHeaders } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieValues } from '../../server/remote/guard.ts'
import { createPreviewAccess } from '../../server/remote/preview/access.ts'
import { createPreviewGateway, type PreviewGateway } from '../../server/remote/preview/gateway.ts'
import type { PreviewService } from '../../server/remote/preview/services.ts'
import type { UpstreamTarget } from '../../server/remote/preview/upstream.ts'

// lens-remote-1: a phone preview listener is a loopback port any web page can aim a DNS-rebinding
// request at (that is why every listener checks Host). A caller that did not come through Tailscale
// for this port, or that Tailscale did not identify as an allowed login, must learn nothing about
// the tailnet: the "Back to Cockpit" link on its refusal page spelled out the Mac's tailnet name.

const HOSTNAME = 'secret-mac.tail4242.ts.net'
const CONTROL = `https://${HOSTNAME}`
const service: PreviewService = { id: 'svc-a', slot: 0, projectPath: '/p', name: 'dev', commandHash: '0'.repeat(64), createdAt: '' }
const DEVICE_TOKEN = 'device-token'

let gateway: PreviewGateway
let port = 0

beforeAll(async () => {
  gateway = createPreviewGateway({
    access: createPreviewAccess(),
    policy: () => ({ hostname: HOSTNAME, allowedLogins: ['me@x'], controlOrigin: CONTROL }),
    device: (req) => { const values = cookieValues(req, 'cockpit_device'); return values.length === 1 && values[0] === DEVICE_TOKEN ? 'd1' : undefined },
    upstream: async (): Promise<UpstreamTarget | undefined> => undefined,
    listenPort: () => 0,
  })
  port = await gateway.open(service)
})
afterAll(async () => { await gateway.closeAll() })

const identified = (extra: Record<string, string> = {}): Record<string, string> => ({
  host: `${HOSTNAME}:8443`, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=${DEVICE_TOKEN}`, ...extra,
})

function call(path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('lens-remote-1 an unidentified caller of a preview listener learns nothing about the tailnet', () => {
  it('a rebinding page (its own Host, no Tailscale headers) gets a refusal that does not name the tailnet', async () => {
    const r = await call('/', { host: 'attacker.example:47822' })
    expect([r.status, r.headers['x-cockpit-preview']]).toEqual([403, 'denied'])
    expect(r.text).not.toContain(HOSTNAME)
    expect(r.text).not.toContain('tail4242')
  })

  it('the reserved Cockpit path and the bootstrap give the same caller nothing either', async () => {
    const reserved = await call('/__cockpit/anything', { host: 'attacker.example:47822' })
    expect(reserved.status).toBe(404)
    expect(reserved.text).not.toContain(HOSTNAME)
    const boot = await call('/__cockpit/bootstrap', { host: 'attacker.example:47822', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'ticket=x')
    expect(boot.status).toBe(403)
    expect(boot.text).not.toContain(HOSTNAME)
  })

  it('a stranger Tailscale login, or the wrong preview port, is refused without the name too', async () => {
    expect((await call('/', identified({ 'tailscale-user-login': 'stranger@x' }))).text).not.toContain(HOSTNAME)
    expect((await call('/', identified({ host: `${HOSTNAME}:8444` }))).text).not.toContain(HOSTNAME)
  })

  it('an allowed login whose phone is not signed in still gets the way back to Cockpit (positive control)', async () => {
    const r = await call('/', identified({ cookie: 'cockpit_device=nope' }))
    expect([r.status, r.headers['x-cockpit-preview']]).toEqual([401, 'revoked'])
    expect(r.text).toContain(`href="${CONTROL}/"`)
    const reserved = await call('/__cockpit/anything', identified())
    expect(reserved.status).toBe(404)
    expect(reserved.text).toContain(`href="${CONTROL}/"`)
  })
})
