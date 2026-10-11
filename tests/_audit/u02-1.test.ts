import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../../server/start.ts'

// u02-1: a request target of `//` (or `//@`, `///`) makes `new URL(target, 'http://localhost')` throw
// ERR_INVALID_URL inside the API handler *before* its try block, and the `void api(...).then(...)` in
// server/start.ts has no catch. CORRECT behaviour: the server answers the socket (any HTTP status) and
// nothing rejects unhandled.
describe('u02-1: invalid request target must not hang the socket or leak an unhandled rejection', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  /** Sends a raw request line (so the target reaches the server byte for byte) and resolves with the first response bytes, or 'NO RESPONSE'. */
  const rawRequest = (port: number, target: string, waitMs: number): Promise<string> => new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let data = ''
    const done = (value: string): void => { clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => done(data || 'NO RESPONSE'), waitMs)
    socket.on('data', (chunk) => { data += chunk.toString('latin1'); if (data.includes('\r\n')) done(data) })
    socket.on('error', () => done(data || 'NO RESPONSE'))
    socket.on('close', () => done(data || 'NO RESPONSE'))
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
  })

  it.each(['//', '//@', '///'])('answers `GET %s` and raises no unhandled rejection', async (target) => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-u02-1-'))
    running = await startServer({ port: 0, webDist: dir, stateRoot: dir })

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const reply = await rawRequest(running.port, target, 1500)
      // Give Node a tick to surface any unhandled rejection from the dropped promise.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(rejections.map((r) => (r instanceof Error ? `${(r as NodeJS.ErrnoException).code ?? r.name}: ${r.message}` : String(r)))).toEqual([])
      expect(reply).toMatch(/^HTTP\/1\.1 \d{3} /)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
