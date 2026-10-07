// Fixture B for proof:wave-11: a plain Node app (no HMR) that is a different service on a
// different origin. Counts the pokes it receives, so the proof can show another origin's write
// never reached it.
import http from 'node:http'
let pokes = 0
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: 'B', pokes, headers: req.headers })) }
  if (req.method === 'POST' && url.pathname === '/poke') { pokes++; res.writeHead(303, { location: '/' }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Service B</title><body style="font:17px system-ui;margin:20px;background:#fff1e6"><h1>Service B</h1><p>A different app on a different origin. Pokes: <b id="pokes">${pokes}</b></p><form method="post" action="/poke"><button>Poke B</button></form>`)
}).listen(0, '127.0.0.1', function () { console.log(`Local: http://127.0.0.1:${this.address().port}/`) })
