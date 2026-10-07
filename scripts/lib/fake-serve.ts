// Plays `tailscale serve` on loopback for proofs, so no proof ever changes this Mac's real Serve
// config. It reads the table the stand-in CLI keeps (scripts/fixtures/wave11-tailscale: one file
// per HTTPS port, holding its http://127.0.0.1 target) and, for each entry, listens with HTTPS on
// 127.0.0.1:<port> and forwards the way Serve does (recipe 2026-09-29, from ipn/ipnlocal/serve.go):
// the original Host passes through; X-Forwarded-Proto/Host/For are set; client-sent
// Tailscale-User-* headers are replaced by the tailnet identity; WebSocket upgrades pass through.
// `disconnect()` closes every listener, as a phone that lost the tailnet would see it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { createServer, type Server } from 'node:https'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

export interface FakeServeOptions {
  /** The stand-in CLI's folder; its Serve table is <dir>/serve/<https port>. */
  readonly dir: string
  readonly login: string
  readonly cert: string
  readonly key: string
}

const PHONE_ADDRESS = '100.64.0.2'

function servedHeaders(req: IncomingMessage, login: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !name.startsWith('tailscale-')) headers[name] = value
  headers['tailscale-user-login'] = login
  headers['tailscale-user-name'] = 'Proof Owner'
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = req.headers.host ?? ''
  headers['x-forwarded-for'] = PHONE_ADDRESS
  return headers
}

export function startFakeServe(options: FakeServeOptions) {
  const servers = new Map<number, { target: URL; server: Server; sockets: Set<Socket | Duplex> }>()
  let connected = true

  function listen(port: number, target: URL): void {
    const sockets = new Set<Socket | Duplex>()
    // Serve (Go) allows far larger headers than Node's 16 KiB default; the gateway's own limit must be what refuses.
    const server = createServer({ cert: options.cert, key: options.key, maxHeaderSize: 256 * 1024 }, (req, res) => {
      const upstream = httpRequest({ host: target.hostname, port: Number(target.port), method: req.method, path: req.url, headers: servedHeaders(req, options.login) }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Bad gateway (stand-in Serve)') } else res.destroy() })
      req.pipe(upstream)
    })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const up = connect(Number(target.port), target.hostname, () => {
        const lines = Object.entries(servedHeaders(req, options.login)).flatMap(([name, value]) => [value].flat().map((v) => `${name}: ${v}`))
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) up.write(head)
        up.pipe(socket)
        socket.pipe(up)
      })
      sockets.add(socket)
      const end = (): void => { socket.destroy(); up.destroy(); sockets.delete(socket) }
      up.on('error', end); up.on('close', end); socket.on('error', end); socket.on('close', end)
    })
    server.on('connection', (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    server.listen(port, '127.0.0.1')
    servers.set(port, { target, server, sockets })
  }

  function stop(port: number): void {
    const entry = servers.get(port)
    if (!entry) return
    servers.delete(port)
    entry.server.close()
    for (const socket of entry.sockets) socket.destroy()
  }

  /** Brings the listeners in line with the stand-in CLI's table. */
  function reconcile(): void {
    if (!connected) return
    const dir = join(options.dir, 'serve')
    const table = new Map<number, URL>()
    if (existsSync(dir)) for (const file of readdirSync(dir)) table.set(Number(file), new URL(readFileSync(join(dir, file), 'utf8').trim()))
    for (const [port, entry] of servers) if (table.get(port)?.href !== entry.target.href) stop(port)
    for (const [port, target] of table) if (!servers.has(port)) listen(port, target)
  }

  const timer = setInterval(reconcile, 150)
  reconcile()
  return {
    reconcile,
    /** The tailnet goes away for the phone: every Serve listener closes. */
    disconnect(): void { connected = false; for (const port of [...servers.keys()]) stop(port) },
    reconnect(): void { connected = true; reconcile() },
    ports: (): number[] => [...servers.keys()].sort((a, b) => a - b),
    close(): void { clearInterval(timer); for (const port of [...servers.keys()]) stop(port) },
  }
}
