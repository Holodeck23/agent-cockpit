import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../../server/start.ts'
import type { Tailscale } from '../../server/remote/tailscale.ts'
import type { Launcher } from '../../server/threads/manager.ts'

// u13-1: server/remote/service.ts handleRemote() parses req.url with `new URL(req.url, 'http://localhost')`
// before its try block, and the phone listener does `void handleRemote(req, res)` with no catch. A request
// target such as "//" is accepted by Node's HTTP parser but makes new URL() throw, so the promise rejects
// unhandled and the client never gets an answer.
// CORRECT behaviour: the phone listener answers every request (any HTTP status) and raises no unhandled rejection.

const HOST = 'mac.example.ts.net'
const OWNER = 'owner@example.com'

let running: RunningServer | undefined
const dirs: string[] = []
const rejections: unknown[] = []
const onRejection = (reason: unknown): void => { rejections.push(reason) }

afterEach(async () => {
  process.off('unhandledRejection', onRejection)
  await running?.close()
  running = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const viaTailscale = { host: HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': OWNER }

/** Sends a raw request line so the target reaches the phone listener byte for byte. */
function raw(port: number, target: string, waitMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let data = ''
    const done = (value: string): void => { clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => done(data || 'NO RESPONSE'), waitMs)
    socket.on('data', (chunk) => { data += chunk.toString('latin1'); if (data.includes('\r\n')) done(data) })
    socket.on('error', () => done(data || 'NO RESPONSE'))
    socket.on('close', () => done(data || 'NO RESPONSE'))
    socket.on('connect', () => {
      const headers = Object.entries(viaTailscale).map(([k, v]) => `${k}: ${v}`)
      socket.write([`GET ${target} HTTP/1.1`, ...headers, 'Connection: close', '', ''].join('\r\n'))
    })
  })
}

function enableRemote(desktopPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ enabled: true })
    const req = request({ host: '127.0.0.1', port: desktopPort, path: '/api/remote', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`enable returned ${res.statusCode}`))))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('u13-1: phone listener with a request target Node accepts but WHATWG URL rejects', () => {
  it.each(['//', '///'])('answers `GET %s` and raises no unhandled rejection', async (target) => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-audit-u13-1-state-'))
    const web = mkdtempSync(join(tmpdir(), 'cockpit-audit-u13-1-web-'))
    dirs.push(root, web)
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Cockpit</title>')
    const launcher: Launcher = (_req, emit) => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
      close: async () => { emit({ kind: 'exit', code: 0 }) } })
    const tailscale: Tailscale = {
      self: async () => ({ hostname: HOST, login: OWNER }),
      serveTarget: async () => undefined,
      serve: async () => undefined,
      unserve: async () => undefined,
    }
    running = await startServer({ port: 0, stateRoot: root, webDist: web, launchers: { claude: launcher, codex: launcher },
      remote: { tailscale, port: 0 } })
    await enableRemote(running.port)
    const phonePort = running.remote.port()
    expect(phonePort, 'phone listener should be running').toBeTypeOf('number')

    process.on('unhandledRejection', onRejection)
    // Positive control: an ordinary request through the same path is answered.
    expect(await raw(phonePort!, '/', 1500)).toMatch(/^HTTP\/1\.1 200 /)

    const reply = await raw(phonePort!, target, 1500)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rejections.map((r) => (r instanceof Error ? `${(r as NodeJS.ErrnoException).code ?? r.name}: ${r.message}` : String(r)))).toEqual([])
    expect(reply).toMatch(/^HTTP\/1\.1 \d{3} /)
  })
})
