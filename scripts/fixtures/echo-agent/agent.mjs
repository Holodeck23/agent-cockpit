// Local Claude stand-in for packaged proofs. Connects to the actual Cockpit MCP
// bridge on initialize, then returns a short answer for each user turn.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const sessionId = args.includes('--resume') ? valueAfter('--resume') : valueAfter('--session-id')
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const client = new Client({ name: 'echo-proof', version: '1' })
let connected = false
let turn = 0

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'echo-fixture' })

async function initialize() {
  const configPath = valueAfter('--mcp-config')
  if (!configPath) return
  const mcpServers = JSON.parse(configPath.startsWith('{') ? configPath : readFileSync(configPath, 'utf8')).mcpServers
  const config = mcpServers?.cockpit
  if (!config) return
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  })
  await client.connect(transport)
  connected = true
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    void initialize().then(
      () => emit({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: {} } }),
      (error) => emit({ type: 'control_response', response: { request_id: message.request_id, subtype: 'error', response: { message: String(error) } } }),
    )
  }
  if (message.type === 'user') {
    if (args.includes('--replay-user-messages')) emit({ ...message, isReplay: true })
    turn++
    emit({ type: 'assistant', message: { id: `echo-${turn}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0, duration_ms: 5 })
  }
})
input.on('close', () => { if (connected) void client.close() })
