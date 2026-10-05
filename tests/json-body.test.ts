import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { HttpError, readJson, sendJson } from '../server/http/json.ts'

describe('readJson over the size limit', () => {
  it('answers 413 without destroying the connection, so the next request on it works (CI hang, R9)', async () => {
    const seen: Array<{ status: number; socketDestroyed: boolean }> = []
    const server = createServer((req: IncomingMessage, res) => {
      readJson(req, 1000).then(
        () => sendJson(res, 200, { ok: true }),
        (error: unknown) => {
          seen.push({ status: error instanceof HttpError ? error.status : 500, socketDestroyed: req.socket.destroyed })
          sendJson(res, error instanceof HttpError ? error.status : 500, { error: 'x' })
        },
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    try {
      const big = await fetch(url, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(200_000) }) })
      expect(big.status).toBe(413)
      expect(seen[0]).toEqual({ status: 413, socketDestroyed: false })
      const next = await fetch(url, { method: 'POST', body: JSON.stringify({ small: true }) })
      expect(next.status).toBe(200)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('still reads a body under the limit, and an empty one as {}', async () => {
    const server = createServer((req, res) => { readJson(req).then((body) => sendJson(res, 200, body), () => sendJson(res, 400, {})) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    try {
      expect(await (await fetch(url, { method: 'POST', body: '{"a":1}' })).json()).toEqual({ a: 1 })
      expect(await (await fetch(url, { method: 'POST' })).json()).toEqual({})
      expect((await fetch(url, { method: 'POST', body: '{nope' })).status).toBe(400)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
