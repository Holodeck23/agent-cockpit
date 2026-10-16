// Pinned Claude + a local MCP fixture: observe startup state and a real harmless tool call.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePrivateClaudeConfig } from '../server/agents/claude/private-config.ts'

const cli = process.env.COCKPIT_W13_CLAUDE
assert.ok(cli, 'Set COCKPIT_W13_CLAUDE to the pinned Claude CLI path')
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(hash(realpathSync(cli)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
assert.match(execFileSync(cli, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(hash(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
const fixture = fileURLToPath(new URL('./fixtures/w13-mcp-ping.mjs', import.meta.url))
const cwd = mkdtempSync(join(tmpdir(), 'cockpit-w13-mcp-ping-'))
const config = writePrivateClaudeConfig({ mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [fixture] } } },
  { disableAllHooks: true })
const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', config.mcpFile,
  '--setting-sources', '', '--settings', config.settingsFile,
  '--allowedTools', 'mcp__fixture__ping,ToolSearch', '--model', 'haiku']
const child = spawn(cli, args, { cwd, env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', init: Record<string, unknown> | undefined, result: Record<string, unknown> | undefined
const toolNames: string[] = [], toolResults: string[] = [], systemUpdates: string[] = [], assistantText: string[] = []
let stderr = ''
const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000)
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let end: number
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (message.type === 'system') {
      if (message.subtype === 'init') init = message
      else systemUpdates.push(String(message.subtype ?? 'unknown'))
    }
    if (message.type === 'assistant') {
      const content = (message.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) for (const part of content) {
        if (part?.type === 'tool_use') toolNames.push(String(part.name))
        if (part?.type === 'text') assistantText.push(String(part.text))
      }
    }
    if (message.type === 'user') {
      const content = (message.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) for (const part of content) if (part?.type === 'tool_result') toolResults.push(JSON.stringify(part.content))
    }
    if (message.type === 'result') { result = message; child.stdin.end() }
  }
})
child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 300) })
let exit: { code: number | null; signal: NodeJS.Signals | null }
try {
  const finished = new Promise<typeof exit>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text',
    text: 'Find the fixture MCP ping tool, call it exactly once, then reply with its W13 marker. Use no other tools except ToolSearch.' }] } })}\n`)
  exit = await finished
} finally {
  clearTimeout(timeout)
  config.remove()
  rmSync(cwd, { recursive: true, force: true })
}
assert.equal(exit.code, 0, stderr || `CLI exited ${exit.code ?? exit.signal}`)
assert.ok(init, 'No initialization event')
assert.equal((result as { is_error?: boolean } | undefined)?.is_error, false, 'CLI turn failed')
assert.equal(toolNames.filter((name) => name === 'mcp__fixture__ping').length, 1,
  `The fixture tool was not called exactly once: ${toolNames.join(', ')}`)
assert.ok(toolResults.some((value) => value.includes('W13-PONG')), 'The fixture returned no marker')
assert.ok(assistantText.some((value) => value.includes('W13-PONG')), 'The model did not report the marker')
console.log(JSON.stringify({ cliVersion: '2.1.220', source: 'local synthetic MCP fixture',
  initServers: init.mcp_servers, initToolCount: Array.isArray(init.tools) ? init.tools.length : null,
  systemUpdateCounts: Object.fromEntries([...new Set(systemUpdates)].map((name) => [name, systemUpdates.filter((item) => item === name).length])),
  toolNames, fixtureCallSucceeded: true }, null, 2))
