import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
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

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => (text += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('startServer', () => {
  let running: RunningServer | undefined
  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  const start = async (preferredPort?: number): Promise<RunningServer> => {
    const webDist = mkdtempSync(join(tmpdir(), 'cockpit-web-'))
    writeFileSync(join(webDist, 'index.html'), '<h1>cockpit page</h1>')
    running = await startServer({ port: 0, preferredPort, webDist, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-state-')) })
    return running
  }

  it('reuses a preferred port, so the page keeps its origin across restarts', async () => {
    const first = await start()
    const port = first.port
    await first.close()
    const again = await start(port)
    expect(again.port).toBe(port)
    expect((await get(port, '/api/threads')).status).toBe(200)
  })

  it('falls back to a free port when the preferred one is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const taken = (blocker.address() as AddressInfo).port
    try {
      const server = await start(taken)
      expect(server.port).not.toBe(taken)
      expect((await get(server.port, '/api/threads')).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('reports agent installation for the picker', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'cockpit-web-'))
    writeFileSync(join(webDist, 'index.html'), '<h1>cockpit page</h1>')
    running = await startServer({ port: 0, webDist, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-state-')),
      agentProbe: async (command) => ({ installed: true, version: `${command} 1.0` }) })
    const res = await get(running.port, '/api/agents')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: [
      { id: 'claude', installation: { installed: true, version: 'claude 1.0' } },
      { id: 'codex', installation: { installed: true, version: 'codex 1.0' } },
      { id: 'antigravity', installation: { installed: true, version: 'agy 1.0' } },
      { id: 'opencode', installation: { installed: true, version: 'opencode 1.0' } },
    ] })
  })

  it('listens on a random loopback port and trusts that port', async () => {
    const server = await start()
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    const threads = await get(server.port, '/api/threads')
    expect(threads.status).toBe(200)
    expect(JSON.parse(threads.body)).toEqual({ data: [] })
  })

  it('opens a project folder and lists it', async () => {
    const server = await start()
    const folder = mkdtempSync(join(tmpdir(), 'cockpit-proj-'))
    const opened = await post(server.port, '/api/projects', { path: folder, pinned: true })
    expect(opened.status).toBe(200)
    const listed = await get(server.port, '/api/projects')
    expect(JSON.parse(listed.body).data).toMatchObject([{ path: folder, pinned: true }])
    expect((await post(server.port, '/api/projects', { path: join(folder, 'missing') })).status).toBe(400)
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

  it('lists, reads and stops project processes, and stops them on close', async () => {
    const server = await start()
    const folder = mkdtempSync(join(tmpdir(), 'cockpit-proj-'))
    expect(JSON.parse((await get(server.port, '/api/processes')).body)).toEqual({ data: [] })
    const { process: started } = server.processes.start({
      projectPath: folder,
      command: `"${process.execPath}" -e "console.log('ready'); setInterval(() => {}, 1000)"`,
    })
    const listed = JSON.parse((await get(server.port, `/api/processes?project=${encodeURIComponent(folder)}`)).body)
    expect(listed.data).toMatchObject([{ id: started.id, status: 'running' }])
    expect((await get(server.port, '/api/processes/proc-999/output')).status).toBe(404)
    expect((await get(server.port, `/api/processes/${started.id}/output?tail=-1`)).status).toBe(400)
    const stopped = await post(server.port, `/api/processes/${started.id}/stop`, {})
    expect(JSON.parse(stopped.body).data).toMatchObject({ id: started.id, status: 'exited' })
    const other = server.processes.start({ projectPath: folder, command: 'sleep 30', name: 'sleeper' })
    await server.close()
    expect(server.processes.get(other.process.id)?.status).not.toBe('running')
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
