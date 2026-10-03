// Synthetic provider, real Cockpit MCP stdio tools and approval card. No network provider usage.
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const args = process.argv.slice(2)
if (args.includes('--permission-prompts') === (process.env.COCKPIT_FIXTURE_LEGACY === '1')) throw new Error('Wrong permission argv for fixture capabilities')
const resume = args[args.indexOf('--resume') + 1]
const session = args[args.indexOf('--session-id') + 1] ?? resume
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
emit({ type: 'system', subtype: 'init', session_id: resume || session })
let resolveApproval
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
async function run() {
  const client = new Client({ name: 'recovery-proof', version: '1' })
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.cockpit
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } })
  try {
    await client.connect(transport)
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return result
    }
    await call('list_processes')
    const command = `${quote(process.env.COCKPIT_FIXTURE_NODE)} server.cjs`
    const allowed = new Promise((resolve) => { resolveApproval = resolve })
    emit({ type: 'control_request', request_id: 'recovery-start', request: { subtype: 'can_use_tool', tool_name: 'mcp__cockpit__start_process', input: { command, name: 'Recovered app' } } })
    if (!(await allowed)) {
      emit({ type: 'assistant', message: { id: 'denied', content: [{ type: 'text', text: 'Startup was denied. No app was inspected.' }] } })
      emit({ type: 'result', subtype: 'success', is_error: false, result: 'Stopped after denial.' })
      return
    }
    await call('start_process', { command, name: 'Recovered app' })
    const list = await call('list_processes')
    const info = JSON.parse(JSON.stringify(list.content))
    const url = JSON.stringify(info).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (!url) throw new Error('No emitted URL')
    const response = await fetch(`${process.env.COCKPIT_MCP_URL}/api/mcp/processes`, { headers: { authorization: `Bearer ${process.env.COCKPIT_MCP_TOKEN}` } })
    const { data } = await response.json()
    await call('read_process_output', { id: data[0].id })
    await call('open_preview', { url })
    const image = await call('inspect_preview', { url })
    if (!image.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')) throw new Error('No PNG inspection')
    const text = `Resumed ${resume}. Opened the app and inspected its PNG. Continue the theme task, check the header contrast, or save the startup workflow.`
    emit({ type: 'assistant', message: { id: 'recovery-done', content: [{ type: 'text', text }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, result: text })
  } catch (e) { emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(e) }) }
  finally { await client.close() }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'user') void run()
  if (message.type === 'control_response') resolveApproval?.(message.response?.response?.behavior === 'allow')
})
