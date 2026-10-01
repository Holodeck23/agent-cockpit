// Records a short real `gemini --acp` session (Agent Client Protocol, JSON-RPC over stdio) into
// tests/fixtures/gemini-acp-*.jsonl, for the Gemini adapter's parser tests. Two small prompts on the
// user's own Gemini login: a one-word reply, then a shell command that needs an approval (allowed once).
// Run: tsx scripts/record-gemini-acp.ts   (paths in the recording are replaced with /work/demo)
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-acp-')))
writeFileSync(join(cwd, 'README.md'), '# demo\n')
const lines: string[] = []
const child = spawn('gemini', ['--acp', '--skip-trust'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
let nextId = 1
const waiting = new Map<number, (result: unknown) => void>()
const send = (message: Record<string, unknown>): void => {
  const line = JSON.stringify({ jsonrpc: '2.0', ...message })
  lines.push(`> ${line}`)
  child.stdin.write(`${line}\n`)
}
const request = <T>(method: string, params: unknown): Promise<T> => new Promise((resolve) => {
  const id = nextId++
  waiting.set(id, resolve as (r: unknown) => void)
  send({ id, method, params })
})
createInterface({ input: child.stdout }).on('line', (line) => {
  lines.push(`< ${line}`)
  const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown; params?: Record<string, unknown> }
  if (message.method === 'session/request_permission' && message.id !== undefined) {
    const options = (message.params?.options ?? []) as Array<{ optionId: string; kind: string }>
    const allow = options.find((o) => o.kind === 'allow_once') ?? options[0]
    send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } })
  } else if (message.id !== undefined && waiting.has(message.id)) {
    waiting.get(message.id)!(message.result ?? message.error)
    waiting.delete(message.id)
  }
})

// A stalled agent (sign-in prompt, trust prompt) must not hang the recorder: dump what we have and stop.
const watchdog = setTimeout(() => {
  console.log(`stalled after 90 s; last lines:\n${lines.slice(-6).map((l) => l.slice(0, 300)).join('\n')}`)
  child.kill('SIGTERM')
  process.exit(1)
}, 90_000)
const init = await request<Record<string, unknown>>('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
console.log('initialize →', JSON.stringify(init).slice(0, 400))
const session = await request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] })
console.log('session →', JSON.stringify(session).slice(0, 200))
console.log('turn 1 →', JSON.stringify(await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with the single word READY and nothing else.' }] })))
console.log('turn 2 →', JSON.stringify(await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Run the shell command `echo cockpit-check` and tell me what it printed, in one short sentence.' }] })))
clearTimeout(watchdog)
child.stdin.end()
await new Promise((resolve) => child.on('exit', resolve))
const out = join(ROOT, 'tests/fixtures/gemini-acp-session.jsonl')
writeFileSync(out, `${lines.map((l) => l.split(cwd).join('/work/demo')).join('\n')}\n`)
console.log(`wrote ${lines.length} lines to tests/fixtures/gemini-acp-session.jsonl`)
