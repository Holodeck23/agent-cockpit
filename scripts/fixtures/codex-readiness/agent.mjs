// Synthetic Codex transport, actual packaged Cockpit bridge. Never reads a provider profile/login.
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('codex-cli 0.162.1 (synthetic readiness fixture)'); process.exit(0) }
assert.equal(args[0], 'app-server')
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => emit({ id, result })
let client, releaseTimer
const config = (key) => args.find((arg) => arg.startsWith(key + '='))?.slice(key.length + 1)
const mark = (name, text = 'observed') => writeFileSync(join(process.env.COCKPIT_CODEX_READINESS_MARKERS, name), text)
const threadId = 'synthetic-codex-' + process.pid

async function connect() {
  const bundle = process.env.COCKPIT_CODEX_PROOF_PACKAGE
  const command = JSON.parse(config('mcp_servers.cockpit.command'))
  const bridgeArgs = JSON.parse(config('mcp_servers.cockpit.args'))
  assert.equal(command, join(bundle, 'Contents/MacOS/Cockpit'))
  assert.deepEqual(bridgeArgs, [join(bundle, 'Contents/Resources/app.asar/dist-electron/mcp.cjs')])
  assert.deepEqual(JSON.parse(config('mcp_servers.cockpit.env_vars')).sort(), ['COCKPIT_MCP_TOKEN', 'COCKPIT_MCP_URL'])
  assert.ok(!args.some((arg) => arg.includes(process.env.COCKPIT_MCP_TOKEN)))
  client = new Client({ name: 'codex-readiness-fixture', version: '1' })
  await client.connect(new StdioClientTransport({ command, args: bridgeArgs, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }))
  mark('bridge-connected')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line), id = message.id
  if (id === undefined || !message.method) return
  if (message.method === 'initialize') reply(id, {})
  else if (message.method === 'config/read') reply(id, {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"config":{}}]})
  else if (message.method === 'account/read') reply(id, {
    account: { type: 'chatgpt', email: 'w13-readiness@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true,
  })
  else if (message.method === 'model/list') reply(id, { data: [], nextCursor: null })
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    mark('thread-ready')
    reply(id, { thread: { id: threadId } })
    releaseTimer = setInterval(() => {
      if (!existsSync(process.env.COCKPIT_CODEX_BRIDGE_RELEASE)) return
      clearInterval(releaseTimer)
      void connect().catch(() => { mark('bridge-error'); process.exitCode = 1; process.stdin.destroy() })
    }, 25)
  } else if (message.method === 'turn/start') {
    mark('input-read', JSON.stringify(message.params.input))
    reply(id, { turn: { id: 'turn-1' } })
    emit({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } })
    emit({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'reply', text: 'Authenticated fixture task completed.' } } })
    emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } })
  } else reply(id, {})
}).on('close', () => { clearInterval(releaseTimer); void client?.close() })
