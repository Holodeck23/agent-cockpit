// Bounded direct-CLI comparison input: exact approved connector subset, no user hooks or tool calls.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotMcpSources } from '../server/agents/claude/mcp-sources.ts'
import { writePrivateClaudeConfig } from '../server/agents/claude/private-config.ts'

const cli = process.env.COCKPIT_W13_CLAUDE
assert.ok(cli, 'Set COCKPIT_W13_CLAUDE to the pinned Claude CLI path')
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(hash(realpathSync(cli)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
assert.match(execFileSync(cli, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(hash(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')

const cwd = mkdtempSync(join(tmpdir(), 'cockpit-w13-cli-sources-'))
mkdirSync(cwd, { recursive: true })
const sourceInput = { home: homedir(), cwd, pathEnv: process.env.PATH ?? '', accountId: 'default-claude', accountGeneration: 1 }
const snapshot = snapshotMcpSources(sourceInput)
assert.equal(snapshotMcpSources(sourceInput).revision, snapshot.revision, 'Sources changed before launch')
const privateConfig = writePrivateClaudeConfig({ mcpServers: snapshot.servers }, { disableAllHooks: true })
const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', privateConfig.mcpFile,
  '--setting-sources', '', '--settings', privateConfig.settingsFile, '--model', 'haiku']
const child = spawn(cli, args, { cwd, env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', init: Record<string, unknown> | undefined, result: Record<string, unknown> | undefined, outputError = ''
const deadline = setTimeout(() => child.kill('SIGTERM'), 90_000)
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let end: number
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (message.type === 'system' && message.subtype === 'init') init = message
    if (message.type === 'result') { result = message; child.stdin.end() }
    if (message.type === 'assistant' && Array.isArray((message.message as { content?: unknown })?.content)
      && ((message.message as { content: { type?: string }[] }).content.some((part) => part.type === 'tool_use'))) {
      outputError = 'Provider attempted a tool call during the no-tools initialization probe'
      child.kill('SIGTERM')
    }
  }
})
child.stderr.on('data', (chunk: Buffer) => { if (outputError.length === 0) outputError = chunk.toString('utf8').slice(0, 160) })
let exit: { code: number | null; signal: NodeJS.Signals | null }
try {
  const finished = new Promise<typeof exit>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply exactly OK. Do not use tools.' }] } })}\n`)
  exit = await finished
} finally {
  clearTimeout(deadline)
  privateConfig.remove()
}
assert.equal(exit.code, 0, outputError || `CLI exited ${exit.code ?? exit.signal}`)
assert.ok(init, 'No Claude initialization event')
assert.equal((init as { claude_code_version?: string }).claude_code_version, '2.1.220')
assert.equal((result as { is_error?: boolean } | undefined)?.is_error, false, 'CLI turn failed')
const declared = [...Object.keys(snapshot.servers)].sort()
const advertised = Array.isArray(init.mcp_servers) ? init.mcp_servers.map((entry: unknown) =>
  typeof entry === 'string' ? { name: entry } : entry && typeof entry === 'object'
    ? { name: String((entry as { name?: unknown }).name ?? ''), status: String((entry as { status?: unknown }).status ?? '') }
    : { name: '' }) : []
const tools = Array.isArray(init.tools) ? init.tools.filter((name): name is string => typeof name === 'string') : []
const toolIdentity = Object.fromEntries(declared.map((name) => {
  const names = tools.filter((tool) => tool.startsWith(`mcp__${name}__`)).sort()
  return [name, { count: names.length, sha256: createHash('sha256').update(JSON.stringify(names)).digest('hex') }]
}))
console.log(JSON.stringify({ cliVersion: '2.1.220', cliSha256: hash(realpathSync(cli)), nodeSha256: hash(process.execPath),
  sourceRevision: snapshot.revision, declared, unavailable: snapshot.unavailable.map((item) => item.name), advertised,
  toolIdentity, memory: { autoPathAdvertised: Boolean((init.memory_paths as { auto?: unknown } | undefined)?.auto) },
  noToolTurnSucceeded: true, connectorReadinessProved: false }, null, 2))
