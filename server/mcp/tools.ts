import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { OutputLine } from '../processes/output.ts'
import type { ProcessInfo, ProcessRead } from '../processes/runner.ts'

// The tools an agent sees as mcp__cockpit__*. They are thin: each one is a
// call back to the cockpit's /api/mcp routes, which enforce the project scope.

export interface CockpitApi {
  list(): Promise<ProcessInfo[]>
  start(body: { command: string; name?: string }): Promise<{ process: ProcessInfo; reused: boolean }>
  read(id: string, options: { since?: number; tail?: number }): Promise<ProcessRead>
  stop(id: string): Promise<ProcessInfo>
  preview(url: string): Promise<{ opened: string }>
}

export function createCockpitApi(baseUrl: string, token: string): CockpitApi {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}/api/mcp${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: string }
    if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? `Cockpit returned ${response.status}`)
    return payload.data
  }
  const query = (options: { since?: number; tail?: number }): string => {
    const params = new URLSearchParams()
    if (options.since !== undefined) params.set('since', String(options.since))
    if (options.tail !== undefined) params.set('tail', String(options.tail))
    return params.size ? `?${params}` : ''
  }
  return {
    list: () => call('GET', '/processes'),
    start: (body) => call('POST', '/processes', body),
    read: (id, options) => call('GET', `/processes/${encodeURIComponent(id)}/output${query(options)}`),
    stop: (id) => call('POST', `/processes/${encodeURIComponent(id)}/stop`, {}),
    preview: (url) => call('POST', '/preview', { url }),
  }
}

function describe(info: ProcessInfo): string {
  const state =
    info.status === 'exited'
      ? `exited${info.exitCode !== null ? ` with code ${info.exitCode}` : ''}${info.signal ? ` (${info.signal})` : ''}`
      : info.status
  return `${info.id} "${info.name}" — ${state}${info.url ? ` — ${info.url}` : ''}`
}

function formatLines(lines: readonly OutputLine[]): string {
  if (lines.length === 0) return '(no output yet)'
  return lines.map((line) => `${line.stream === 'stderr' ? '! ' : '  '}${line.text}`).join('\n')
}

function formatRead(read: ProcessRead): string {
  const range = read.lines.length ? `lines ${read.lines[0]?.seq}–${read.lines.at(-1)?.seq}` : 'no new lines'
  const dropped = read.dropped ? ` (${read.dropped} older lines were dropped)` : ''
  return `${describe(read.process)}\n${range}; pass since=${read.next} to get only newer output${dropped}. "! " marks stderr.\n\n${formatLines(read.lines)}`
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const failure = (error: unknown) => ({ ...text(error instanceof Error ? error.message : String(error)), isError: true })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** After a start, wait until the process prints its URL, exits, or `seconds` pass. */
async function settle(api: CockpitApi, id: string, seconds: number): Promise<ProcessRead> {
  const deadline = Date.now() + seconds * 1000
  let read = await api.read(id, { tail: 60 })
  while (Date.now() < deadline && read.process.status === 'running' && !read.process.url) {
    await sleep(250)
    read = await api.read(id, { tail: 60 })
  }
  return read
}

export function createCockpitMcpServer(api: CockpitApi): McpServer {
  const server = new McpServer({ name: 'cockpit', version: '0.1.0' })

  server.registerTool(
    'start_process',
    {
      title: 'Start a long-running process',
      description:
        'Start a long-running command for this project (dev server, watcher, `npm run dev`) and keep it running in Cockpit, ' +
        'where the user can see it. Returns once it prints a local URL, exits, or wait_seconds pass, with its first output. ' +
        'Starting a name that is already running returns the running one instead of a second copy.',
      inputSchema: {
        command: z.string().min(1).max(2000).describe('Shell command, run in the project folder, e.g. "npm run dev"'),
        name: z.string().min(1).max(60).optional().describe('Short label; defaults to the command'),
        wait_seconds: z.number().min(0).max(60).optional().describe('How long to wait for startup output (default 10)'),
      },
    },
    async ({ command, name, wait_seconds }) => {
      try {
        const { process: started, reused } = await api.start({ command, ...(name ? { name } : {}) })
        const read = await settle(api, started.id, reused ? 0 : (wait_seconds ?? 10))
        const lead = reused ? 'Already running (not started again).' : 'Started.'
        return text(`${lead}\n${formatRead(read)}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'list_processes',
    {
      title: 'List processes',
      description: "List this project's processes started through Cockpit, with status and detected local URL.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const all = await api.list()
        return text(all.length ? all.map(describe).join('\n') : 'No processes for this project.')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'read_process_output',
    {
      title: 'Read process output',
      description:
        "Read a process's recent stdout/stderr (the dev-server log). Use `since` from the previous read to get only new lines.",
      inputSchema: {
        id: z.string().min(1).max(40).describe('Process id from start_process or list_processes, e.g. "proc-1"'),
        since: z.number().int().min(0).optional().describe('Only lines after this line number'),
        tail: z.number().int().min(1).max(2000).optional().describe('At most this many of the latest lines (default 100)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, since, tail }) => {
      try {
        return text(formatRead(await api.read(id, { ...(since !== undefined ? { since } : {}), tail: tail ?? 100 })))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'stop_process',
    {
      title: 'Stop a process',
      description: 'Stop a process started through Cockpit, including everything it spawned.',
      inputSchema: { id: z.string().min(1).max(40).describe('Process id, e.g. "proc-1"') },
    },
    async ({ id }) => {
      try {
        return text(`Stopped. ${describe(await api.stop(id))}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'open_preview',
    {
      title: 'Open a preview',
      description:
        'Show the user a local page of the running app (localhost only). Give a url, or a process id to use the URL it printed; ' +
        'with neither, uses the one running process that printed a URL.',
      inputSchema: {
        url: z.string().min(1).max(2000).optional().describe('e.g. "http://localhost:5173/"'),
        id: z.string().min(1).max(40).optional().describe('Process id whose URL to open'),
      },
    },
    async ({ url, id }) => {
      try {
        let target = url
        if (!target) {
          const all = await api.list()
          const candidates = all.filter((p) => p.status === 'running' && p.url && (!id || p.id === id))
          if (candidates.length !== 1) {
            return failure(
              candidates.length
                ? `Several running processes have URLs (${candidates.map((p) => p.id).join(', ')}); pass id or url.`
                : 'No running process has printed a local URL yet; pass url, or check read_process_output.',
            )
          }
          target = candidates[0]?.url
        }
        const { opened } = await api.preview(target ?? '')
        return text(`Opened ${opened} for the user.`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  return server
}
