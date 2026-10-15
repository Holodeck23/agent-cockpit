// Isolated source-level Cockpit host. Only read-only /processes is exposed.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMcpSessions } from '../server/mcp/sessions.ts'
import { createProcessRunner } from '../server/processes/runner.ts'
import { handleMcpRoute } from '../server/http/mcp-routes.ts'
import { HttpError, sendJson } from '../server/http/json.ts'

const out = resolve(process.argv[2]!)
const sessions = createMcpSessions()
const processes = createProcessRunner({ graceMs: 100 })
const token = sessions.issue({ threadId: 'collision-proof', cwd: out, projectPath: out })
const log = (event: object) => appendFileSync(`${out}/host.jsonl`, JSON.stringify(event) + '\n')
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  res.on('finish', () => log({ path: url.pathname, status: res.statusCode,
    authenticated: req.headers.authorization === `Bearer ${token}` }))
  if (req.method !== 'GET' || url.pathname !== '/api/mcp/processes') {
    sendJson(res, 404, { error: 'Probe exposes only process listing' }); return
  }
  handleMcpRoute(req, res, url, url.pathname.split('/').filter(Boolean), {
    sessions, processes, openUrl: () => { throw new Error('Not exposed') },
  }).catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
    { error: (error as Error).message }))
})
server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const url = `http://127.0.0.1:${address.port}`
  // Negative control is an expected synthetic authentication failure, not a live account retry.
  const negative = await fetch(`${url}/api/mcp/processes`, { signal: AbortSignal.timeout(2000) })
  if (negative.status !== 401) throw new Error('Unauthenticated control was accepted')
  writeFileSync(`${out}/config.json`, JSON.stringify({ mcpServers: { cockpit: {
    type: 'stdio', command: process.execPath,
    args: [resolve('spike-harness/auth-bridge.cjs'), out, resolve('.')],
    env: { COCKPIT_MCP_TOKEN: token, COCKPIT_MCP_URL: url },
  } } }), { mode: 0o600, flag: 'wx' })
  console.log('ready')
})
process.once('SIGTERM', () => {
  sessions.revoke(token)
  void processes.shutdown().finally(() => server.close(() => process.exit(0)))
})
