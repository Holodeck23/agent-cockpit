import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { createApiHandler } from './http/router.ts'
import { createThreadManager, type ThreadManager } from './threads/manager.ts'
import { createThreadStore, defaultRoot, type ThreadStore } from './threads/store.ts'

export interface StartOptions {
  /** 0 picks a free port. */
  readonly port: number
  readonly host?: string
  /** Folder holding the built web UI (index.html + assets). */
  readonly webDist: string
  /** Extra ports whose pages may call the API, e.g. the Vite dev server. */
  readonly trustedPorts?: readonly number[]
  /** Where threads are stored; defaults to COCKPIT_HOME or ~/.agent-cockpit. */
  readonly stateRoot?: string
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly store: ThreadStore
  readonly manager: ThreadManager
  /** Stops agent sessions, then the HTTP server (including open SSE streams). */
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
}

function serveStatic(webDist: string, pathname: string, res: ServerResponse): void {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(webDist, safe)
  if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('Web UI not built. Run `npm run build`, or use `npm run dev:web` during development.')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
  const store = createThreadStore(options.stateRoot ?? defaultRoot())
  const manager = createThreadManager(store)
  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  // The API guard needs the real port, which is only known after listen when port is 0.
  const port = (server.address() as AddressInfo).port
  const api = createApiHandler(manager, store, [port, ...(options.trustedPorts ?? [])])
  server.on('request', (req, res) => {
    void api(req, res).then((handled) => {
      if (!handled) serveStatic(options.webDist, new URL(req.url ?? '/', 'http://localhost').pathname, res)
    })
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await manager.shutdown()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })()
    return closing
  }

  return { url: `http://${host}:${port}`, port, store, manager, close }
}
