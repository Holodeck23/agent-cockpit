import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../server/start.ts'

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('startServer', () => {
  let running: RunningServer | undefined
  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  const start = async (): Promise<RunningServer> => {
    const webDist = mkdtempSync(join(tmpdir(), 'cockpit-web-'))
    writeFileSync(join(webDist, 'index.html'), '<h1>cockpit page</h1>')
    running = await startServer({ port: 0, webDist, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-state-')) })
    return running
  }

  it('listens on a random loopback port and trusts that port', async () => {
    const server = await start()
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    const threads = await get(server.port, '/api/threads')
    expect(threads.status).toBe(200)
    expect(JSON.parse(threads.body)).toEqual({ data: [] })
  })

  it('still rejects a foreign Host header', async () => {
    const server = await start()
    expect((await get(server.port, '/api/threads', 'evil.example')).status).toBe(403)
  })

  it('serves the built page for non-API paths', async () => {
    const server = await start()
    const page = await get(server.port, '/some/route')
    expect(page.status).toBe(200)
    expect(page.body).toContain('cockpit page')
  })

  it('closes with an SSE stream still open', async () => {
    const server = await start()
    await new Promise<void>((resolve) => {
      request({ host: '127.0.0.1', port: server.port, path: '/api/stream' }, () => resolve())
        .on('error', () => undefined)
        .end()
    })
    await expect(server.close()).resolves.toBeUndefined()
    await expect(get(server.port, '/api/threads')).rejects.toThrow()
  })
})
