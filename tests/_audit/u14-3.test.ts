import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieValues } from '../../server/remote/guard.ts'
import { createPreviewAccess } from '../../server/remote/preview/access.ts'
import { createPreviewGateway, rewriteLocation, type PreviewGateway } from '../../server/remote/preview/gateway.ts'
import type { PreviewService } from '../../server/remote/preview/services.ts'
import type { UpstreamTarget } from '../../server/remote/preview/upstream.ts'

// u14-3: a redirect back to the dev server that starts with two slashes must stay a path on the
// preview origin, never become a protocol-relative URL to another site.

const target: UpstreamTarget = { hostname: 'localhost', port: 5173, host: 'localhost:5173', generation: 'g1' }
const PREVIEW = 'https://mac.tail.ts.net:8443/login'
const resolved = (location: string): URL => new URL(location, PREVIEW)

describe('u14-3 rewriteLocation keeps redirects on the preview origin', () => {
  it.each([
    'http://localhost:5173//evil.example/x',
    'http://localhost:5173/\\evil.example/x',
    'http://localhost:5173/\\\\evil.example/x',
    'http://localhost:5173///evil.example/x?next=1#frag',
    'http://127.0.0.1:5173//evil.example/',
  ])('%s does not leave the preview origin', (location) => {
    const out = rewriteLocation(location, target)
    expect(out.startsWith('//')).toBe(false)
    expect(resolved(out).host).toBe('mac.tail.ts.net:8443')
  })

  it('still rewrites ordinary redirects to a path, query and fragment', () => {
    expect(rewriteLocation('http://localhost:5173/landed?x=1#top', target)).toBe('/landed?x=1#top')
    expect(rewriteLocation('http://localhost:5173', target)).toBe('/')
    expect(rewriteLocation('http://localhost:5173/a//b', target)).toBe('/a//b')
  })

  it('leaves other sites and relative locations as they were', () => {
    expect(rewriteLocation('https://example.com/', target)).toBe('https://example.com/')
    expect(rewriteLocation('/next', target)).toBe('/next')
  })
})

describe('u14-3 through the gateway', () => {
  const service: PreviewService = { id: 'svc-a', slot: 0, projectPath: '/p', name: 'dev', commandHash: '0'.repeat(64), createdAt: '' }
  let app: Server
  let gateway: PreviewGateway
  let port = 0
  const access = createPreviewAccess()
  beforeAll(async () => {
    let appPort = 0
    app = createServer((_req, res) => { res.writeHead(302, { location: `http://localhost:${appPort}//evil.example/x` }); res.end() })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
    appPort = (app.address() as AddressInfo).port
    gateway = createPreviewGateway({
      access,
      policy: () => ({ hostname: 'mac.tail.ts.net', allowedLogins: ['me@x'], controlOrigin: 'https://mac.tail.ts.net' }),
      device: (req) => (cookieValues(req, 'cockpit_device')[0] === 'dev' ? 'd1' : undefined),
      upstream: async () => ({ hostname: '127.0.0.1', port: appPort, host: `localhost:${appPort}`, generation: 'g1' }),
      listenPort: () => 0,
    })
    port = await gateway.open(service)
  })
  afterAll(async () => { await gateway.closeAll(); app.close() })

  it('the Location the phone receives stays on the preview origin', async () => {
    const grant = { deviceId: 'd1', login: 'me@x', serviceId: service.id, generation: 'g1', origin: 'https://mac.tail.ts.net:8443' }
    const redeemed = access.redeem(access.issue(grant), grant)
    if (!('session' in redeemed)) throw new Error('no session')
    const location = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', agent: false, headers: {
        host: 'mac.tail.ts.net:8443', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@x', cookie: `cockpit_device=dev; cockpit_pv_0=${redeemed.session.id}`,
      } }, (res) => { res.resume(); resolve(String(res.headers.location)) })
      req.on('error', reject)
      req.end()
    })
    expect(location.startsWith('//')).toBe(false)
    expect(resolved(location).host).toBe('mac.tail.ts.net:8443')
  })
})
