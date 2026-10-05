import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLocalUrl } from '../server/http/mcp-routes.ts'
import { startServer } from '../server/start.ts'

describe('what the page may load', () => {
  it('serves the page with a policy that keeps images, scripts and frames local', async () => {
    const web = mkdtempSync(join(tmpdir(), 'cockpit-policy-web-'))
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Cockpit</title>')
    writeFileSync(join(web, 'app.js'), 'export {}')
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-policy-state-')), webDist: web })
    try {
      const page = await fetch(server.url)
      const policy = page.headers.get('content-security-policy') ?? ''
      expect(policy).toContain("img-src 'self' data: blob:")
      expect(policy).toContain("script-src 'self'")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).toMatch(/frame-src http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/)
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')
      // Scripts and other assets do not need the policy; they are not documents.
      expect((await fetch(`${server.url}/app.js`)).headers.get('content-security-policy')).toBeNull()
    } finally { await server.close() }
  })

  it('never previews Cockpit itself, on any loopback name (L1)', () => {
    expect(() => assertLocalUrl('http://127.0.0.1:4317/', [4317])).toThrow(/Cockpit itself/)
    expect(() => assertLocalUrl('http://localhost:4317/x', [4317, 47821])).toThrow(/Cockpit itself/)
    expect(() => assertLocalUrl('http://[::1]:47821/', [4317, 47821])).toThrow(/Cockpit itself/)
    expect(assertLocalUrl('http://localhost:5173/', [4317])).toBe('http://localhost:5173/')
    expect(() => assertLocalUrl('http://localhost/', [80])).toThrow(/Cockpit itself/)
  })
})
