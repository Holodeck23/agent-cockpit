// The shell proof fixtures use this only for provider initialization. Connect
// to the app-owned packaged bridge, verify the scoped host, then close it.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const path = process.argv[2]
assert.ok(path, 'Missing private MCP config path')
const config = JSON.parse(path.startsWith('{') ? path : readFileSync(path, 'utf8')).mcpServers?.cockpit
assert.ok(config, 'Missing app-owned Cockpit bridge')
const env = { ...process.env, ...config.env }
const identityEnv = process.env.COCKPIT_FIXTURE_LEGACY_ENV === '1' ? env : config.env
assert.ok(identityEnv?.COCKPIT_MCP_URL && identityEnv?.COCKPIT_MCP_TOKEN, 'Missing scoped Cockpit host grant')
const client = new Client({ name: 'packaged-shell-proof', version: '1' })
let connected = false
try {
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args,
    env }))
  connected = true
  const response = await fetch(`${identityEnv.COCKPIT_MCP_URL}/api/mcp/identity`, {
    headers: { authorization: `Bearer ${identityEnv.COCKPIT_MCP_TOKEN}` },
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.server, 'cockpit')
  assert.equal(data.protocol, 1)
  // A worktree turn belongs to the project but runs from its selected checkout.
  assert.equal(realpathSync(data.cwd), realpathSync(process.cwd()))
} finally {
  if (connected) await client.close()
}
