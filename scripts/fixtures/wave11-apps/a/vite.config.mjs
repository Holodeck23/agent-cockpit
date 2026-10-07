// Fixture A for proof:wave-11 (copied into the proof's project folder): a real Vite dev server with
// HMR, plus the server routes a typical app has: a server-session sign-in (HttpOnly cookie), a
// server-side counter, server-sent events, a header echo, an absolute redirect and a route that
// never answers. Ported from the G-PHONE experiment.
import { randomBytes } from 'node:crypto'
const sessions = new Map()
const sid = (req) => /(?:^|;\s*)app_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
export default {
  cacheDir: '.vite-cache',
  logLevel: 'info',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'fixture-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://x')
        if (req.method === 'POST' && url.pathname === '/login') {
          const id = randomBytes(8).toString('hex'); sessions.set(id, { count: 0 })
          res.writeHead(303, { 'set-cookie': `app_sid=${id}; HttpOnly; Path=/`, location: '/' }); return res.end()
        }
        if (req.method === 'POST' && url.pathname === '/inc') {
          const s = sessions.get(sid(req)); if (s) s.count++
          res.writeHead(303, { location: '/' }); return res.end()
        }
        if (url.pathname === '/api/state') {
          const s = sessions.get(sid(req)); res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ loggedIn: Boolean(s), count: s?.count ?? 0 }))
        }
        if (url.pathname === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: 'A', headers: req.headers })) }
        if (url.pathname === '/redirect-abs') { res.writeHead(302, { location: `http://127.0.0.1:${server.httpServer.address().port}/landed` }); return res.end() }
        if (url.pathname === '/slow') return
        if (url.pathname === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); let i = 0
          const t = setInterval(() => { res.write(`data: tick ${++i}\n\n`) }, 500); req.on('close', () => clearInterval(t)); return
        }
        next()
      })
    },
  }],
}
