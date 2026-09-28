import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiHandler } from './http/router.ts'
import { createThreadManager } from './threads/manager.ts'
import { createThreadStore } from './threads/store.ts'

const HOST = '127.0.0.1'
const PORT = Number(process.env.COCKPIT_PORT ?? 4317)
const WEB_DIST = fileURLToPath(new URL('../dist', import.meta.url))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(WEB_DIST, safe)
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('Web UI not built. Run `npm run build`, or use `npm run dev:web` during development.')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

const store = createThreadStore()
const manager = createThreadManager(store)
// The Vite dev server (5173) proxies to us, so its origin is trusted in development.
const api = createApiHandler(manager, store, [PORT, 5173])

const server = createServer((req, res) => {
  void api(req, res).then((handled) => {
    if (!handled) serveStatic(new URL(req.url ?? '/', 'http://localhost').pathname, res)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[cockpit] http://${HOST}:${PORT}  (threads in ${store.root})`)
})

const stop = (): void => {
  manager.shutdown()
  server.close()
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
