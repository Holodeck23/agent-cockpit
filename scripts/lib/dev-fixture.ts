import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A tiny web project with an `npm run dev` that behaves like a real dev server:
// it keeps running, and announces its local URL the way Vite does. Port 0
// avoids collisions between proof runs.

/** What a user would ask. It names no tools: finding them is the agent's job. */
export const DEV_PROMPT = 'Get this project\'s dev server running, check its log for errors, and show me the site.'

export function makeDevProject(prefix = 'cockpit-dev-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'sprout-site', private: true, scripts: { dev: 'node server.js' } }, null, 2),
  )
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Sprout</title><h1>Sprout is growing</h1>\n')
  writeFileSync(
    join(dir, 'server.js'),
    `const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((req, res) => {
  console.log(req.method + ' ' + req.url)
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(fs.readFileSync(__dirname + '/index.html'))
})
server.listen(0, '127.0.0.1', () => {
  console.log('  sprout dev server ready')
  console.log('  ➜  Local:   http://localhost:' + server.address().port + '/')
})
`,
  )
  return dir
}
