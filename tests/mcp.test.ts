import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeMcpOptions, codexMcpConfigArgs } from '../server/mcp/wiring.ts'
import { assertLocalUrl, handleMcpRoute } from '../server/http/mcp-routes.ts'
import { HttpError, sendJson } from '../server/http/json.ts'
import { createMcpSessions, type McpSessions } from '../server/mcp/sessions.ts'
import { createCockpitApi, createCockpitMcpServer } from '../server/mcp/tools.ts'
import { createProcessRunner, type ProcessRunner } from '../server/processes/runner.ts'

interface Harness {
  readonly url: string
  readonly sessions: McpSessions
  readonly processes: ProcessRunner
  readonly opened: string[]
  connect(token: string): Promise<Client>
}

let server: Server | undefined
let runner: ProcessRunner | undefined

afterEach(async () => {
  await runner?.shutdown()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  runner = undefined
})

async function harness(): Promise<Harness> {
  const sessions = createMcpSessions()
  const processes = createProcessRunner({ graceMs: 500 })
  runner = processes
  const opened: string[] = []
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    handleMcpRoute(req, res, url, url.pathname.split('/').filter(Boolean), { sessions, processes, openUrl: (u) => void opened.push(u) }).catch(
      (error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { error: (error as Error).message }),
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    sessions,
    processes,
    opened,
    async connect(token) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await createCockpitMcpServer(createCockpitApi(url, token)).connect(serverSide)
      const client = new Client({ name: 'test', version: '0' })
      await client.connect(clientSide)
      return client
    },
  }
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n')

function devProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'))
  writeFileSync(join(dir, 'dev.js'), "console.log('  Local:   http://localhost:5199/'); console.error('warming up'); setInterval(() => {}, 1000)")
  return dir
}

describe('cockpit MCP tools', () => {
  it('lists the five cockpit tools', async () => {
    const h = await harness()
    const client = await h.connect(h.sessions.issue({ threadId: 't1', projectPath: devProject() }))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['list_processes', 'open_preview', 'read_process_output', 'start_process', 'stop_process'])
  })

  it('starts a dev server, reads its log, and opens its URL for the user', async () => {
    const h = await harness()
    const dir = devProject()
    const client = await h.connect(h.sessions.issue({ threadId: 't1', projectPath: dir }))

    const started = textOf(await client.callTool({ name: 'start_process', arguments: { command: `"${process.execPath}" dev.js`, name: 'dev' } }))
    expect(started).toContain('Started.')
    expect(started).toContain('http://localhost:5199/')
    const [proc] = h.processes.list(dir)
    expect(proc).toMatchObject({ name: 'dev', status: 'running', projectPath: dir })

    const again = textOf(await client.callTool({ name: 'start_process', arguments: { command: 'anything', name: 'dev' } }))
    expect(again).toContain('Already running')

    const log = textOf(await client.callTool({ name: 'read_process_output', arguments: { id: proc?.id } }))
    expect(log).toContain('! warming up')
    expect(log).toMatch(/pass since=\d+/)

    expect(textOf(await client.callTool({ name: 'open_preview', arguments: {} }))).toContain('Opened http://localhost:5199/')
    expect(h.opened).toEqual(['http://localhost:5199/'])

    const stopped = textOf(await client.callTool({ name: 'stop_process', arguments: { id: proc?.id } }))
    expect(stopped).toContain('exited')
  })

  it('refuses to preview a non-local page', async () => {
    const h = await harness()
    const client = await h.connect(h.sessions.issue({ threadId: 't1', projectPath: devProject() }))
    const result = await client.callTool({ name: 'open_preview', arguments: { url: 'https://example.com/' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('only opens local')
    expect(h.opened).toEqual([])
    expect(assertLocalUrl('http://127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(() => assertLocalUrl('file:///etc/passwd')).toThrow()
  })

  it('rejects an unknown or revoked token', async () => {
    const h = await harness()
    const token = h.sessions.issue({ threadId: 't1', projectPath: devProject() })
    h.sessions.revoke(token)
    const client = await h.connect(token)
    const result = await client.callTool({ name: 'list_processes', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('session token')
  })

  it("confines a session to its own project's processes", async () => {
    const h = await harness()
    const other = h.processes.start({ projectPath: devProject(), command: 'sleep 30', name: 'theirs' })
    const client = await h.connect(h.sessions.issue({ threadId: 't2', projectPath: devProject() }))
    expect(textOf(await client.callTool({ name: 'list_processes', arguments: {} }))).toBe('No processes for this project.')
    const read = await client.callTool({ name: 'read_process_output', arguments: { id: other.process.id } })
    expect(read.isError).toBe(true)
    const stop = await client.callTool({ name: 'stop_process', arguments: { id: other.process.id } })
    expect(stop.isError).toBe(true)
    expect(h.processes.get(other.process.id)?.status).toBe('running')
  })
})

describe('MCP wiring per CLI', () => {
  const launch = {
    command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit',
    args: ['/Applications/Cockpit.app/Contents/Resources/app.asar/dist-electron/mcp.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    secretEnv: { COCKPIT_MCP_URL: 'http://127.0.0.1:1234', COCKPIT_MCP_TOKEN: 'secret' },
  }

  it('gives Claude a stdio server, pre-allows the read-only tools, and keeps the token out of the config', () => {
    const options = claudeMcpOptions(launch)
    expect(options.mcpConfig.mcpServers.cockpit).toEqual({ type: 'stdio', command: launch.command, args: launch.args, env: launch.env })
    expect(options.allowedTools).toEqual(['mcp__cockpit__list_processes', 'mcp__cockpit__read_process_output', 'mcp__cockpit__open_preview'])
    expect(JSON.stringify(options.mcpConfig)).not.toContain('secret')
    expect(options.env).toEqual(launch.secretEnv)
  })

  it('gives Codex -c overrides that forward the token by name only', () => {
    const args = codexMcpConfigArgs(launch)
    expect(args.filter((a) => a === '-c')).toHaveLength(args.length / 2)
    const values = args.filter((a) => a !== '-c')
    expect(values).toContain(`mcp_servers.cockpit.command="${launch.command}"`)
    expect(values).toContain('mcp_servers.cockpit.env_vars=["COCKPIT_MCP_URL","COCKPIT_MCP_TOKEN"]')
    expect(values).toContain('mcp_servers.cockpit.env={"ELECTRON_RUN_AS_NODE"="1"}')
    expect(values).toContain('mcp_servers.cockpit.tools.read_process_output.approval_mode="approve"')
    expect(values.join(' ')).not.toContain('secret')
  })
})
