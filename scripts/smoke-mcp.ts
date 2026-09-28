// Cockpit MCP smoke against a real agent, outside the app: `tsx scripts/smoke-mcp.ts claude|codex`.
// Starts the server with the built MCP bundle (run `npm run build:electron` first), gives the agent
// a dev-server task that names no tools, approves whatever it asks, and checks that it started the
// server through Cockpit, read its log, and opened the preview. Claude runs on Haiku.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../server/start.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { DEV_PROMPT, makeDevProject } from './lib/dev-fixture.ts'

const agent = process.argv[2] === 'codex' ? 'codex' : 'claude'
const mcpScript = fileURLToPath(new URL('../dist-electron/mcp.cjs', import.meta.url))
if (!existsSync(mcpScript)) throw new Error('Run `npm run build:electron` first (needs dist-electron/mcp.cjs)')

const webDist = mkdtempSync(join(tmpdir(), 'cockpit-web-'))
writeFileSync(join(webDist, 'index.html'), '<h1>smoke</h1>')
const opened: string[] = []
const running = await startServer({
  port: 0,
  webDist,
  stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-state-')),
  mcp: { command: process.execPath, args: [mcpScript] },
  openUrl: (url) => void opened.push(url),
})

const project = makeDevProject()
const settings = threadSettingsSchema.parse({
  agent,
  model: agent === 'claude' ? 'haiku' : (process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna'),
  permissionMode: 'manual',
})
const tools: string[] = []
const approvals: string[] = []
let meta: ReturnType<typeof running.manager.create> | undefined

const done = new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 240_000)
  running.manager.subscribe(({ threadId, event }) => {
    if (threadId !== meta?.id) return
    if (event.kind === 'tool_use') tools.push(event.name)
    if (event.kind === 'approval_request') {
      approvals.push(event.toolName)
      running.manager.approve(threadId, event.requestId, 'allow')
    }
    if (event.kind === 'error') console.log('  agent error:', event.message.slice(0, 300))
    if (event.kind === 'result') {
      clearTimeout(timer)
      resolve(event.ok)
    }
  })
})
meta = running.manager.create({ projectPath: project, settings, text: DEV_PROMPT })
const ok = await done

const processes = running.processes.list(project)
const live = processes.find((p) => p.status === 'running' && p.url)
const served = live?.url ? await fetch(live.url).then((r) => r.text()).catch(() => '') : ''
const checks: Array<[string, boolean, string]> = [
  ['turn finished', ok, ''],
  ['started the dev server through cockpit', tools.includes('mcp__cockpit__start_process'), tools.join(', ')],
  ['dev server is running with a detected URL', Boolean(live), JSON.stringify(processes.map((p) => [p.name, p.status, p.url]))],
  ['read the dev-server log', tools.includes('mcp__cockpit__read_process_output'), ''],
  ['opened the preview at that URL', Boolean(live?.url) && opened.includes(live?.url ?? ''), opened.join(', ')],
  ['the page is actually served', served.includes('Sprout is growing'), ''],
]
for (const [name, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
console.log(`  approvals asked: ${approvals.join(', ') || 'none'}`)
await running.close()
const passed = checks.every(([, pass]) => pass)
console.log(passed ? `MCP SMOKE PASS (${agent})` : `MCP SMOKE FAIL (${agent})`)
process.exit(passed ? 0 : 1)
