import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorkflowStore } from './workflows/store.ts'
import { createWorkflowRunner } from './workflows/runner.ts'
import { createApiHandler } from './http/router.ts'
import { createAgentStatus, type VersionProbe } from './agents/status.ts'
import { createMcpSessions, MCP_TOKEN_ENV, MCP_URL_ENV, type McpCommand } from './mcp/sessions.ts'
import { createProcessRunner, type ProcessRunner } from './processes/runner.ts'
import { createProjectStore, type ProjectStore } from './projects/store.ts'
import { createMemoryStore } from './memory/store.ts'
import { createThreadManager, type ThreadManager, type ManagerOptions } from './threads/manager.ts'
import { createThreadStore, defaultRoot, type ThreadStore } from './threads/store.ts'
import { createRemoteAccess, type RemoteAccess } from './remote/service.ts'
import { createRemoteStore } from './remote/store.ts'
import { createPushStore, startNotifier, type PushSender } from './remote/push.ts'
import { systemTailscale, type Tailscale } from './remote/tailscale.ts'

export interface StartOptions {
  /** 0 picks a free port. */
  readonly port: number
  /** Inject adapters for deterministic integration tests. */
  readonly launchers?: ManagerOptions['launchers']
  readonly host?: string
  /** Folder holding the built web UI (index.html + assets). */
  readonly webDist: string
  /** Extra ports whose pages may call the API, e.g. the Vite dev server. */
  readonly trustedPorts?: readonly number[]
  /**
   * Tried before `port`; if it is taken, `port` is used. The app passes its last port so the
   * page's origin, and with it localStorage (theme, drafts, layout), survives a restart.
   */
  readonly preferredPort?: number
  /** Where threads are stored; defaults to COCKPIT_HOME or ~/.agent-cockpit. */
  readonly stateRoot?: string
  /** How to start the cockpit MCP server; without it, agent sessions get no cockpit tools. */
  readonly mcp?: McpCommand
  /** Opens a preview for the user; defaults to macOS `open`. The app passes shell.openExternal. */
  readonly openUrl?: (url: string) => Promise<void> | void
  /** Phone access: the Tailscale CLI to drive (a fake in tests) and a port override (0 = any free port). */
  readonly remote?: { readonly tailscale?: Tailscale; readonly port?: number; readonly sendPush?: PushSender }
  /** How agent CLIs are checked for the picker; a fake in tests. */
  readonly agentProbe?: VersionProbe
}

function openWithSystem(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn('open', [url], { stdio: 'ignore' })
      .on('error', reject)
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited with ${code}`))))
  })
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly store: ThreadStore
  readonly manager: ThreadManager
  readonly processes: ProcessRunner
  readonly remote: RemoteAccess
  /** Known project folders; the desktop shell checks these before opening one in Finder. */
  readonly projects: ProjectStore
  /** Stops agent sessions and project processes, then the HTTP server (including open SSE streams). */
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript',
}

function serveStatic(webDist: string, pathname: string, res: ServerResponse): void {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(webDist, safe)
  if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('Web UI not built. Run `npm run build`, or use `npm run dev:web` during development.')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
  const root = options.stateRoot ?? defaultRoot()
  const store = createThreadStore(root)
  const projects = createProjectStore(root)
  const processes = createProcessRunner()
  const sessions = createMcpSessions()
  // Known once listening; sessions only start after that.
  let baseUrl = ''
  const mcpCommand = options.mcp
  const manager = createThreadManager(store, {
    instructions: (projectPath) => {
      const project = projects.list({ includeHidden: true }).find((p) => p.path === projectPath)
      return project?.instructions ? { text: project.instructions, revision: project.instructionsRevision ?? 0 } : undefined
    },
    ...(options.launchers ? { launchers: options.launchers } : {}),
    ...(mcpCommand
      ? {
          mcp: (grant) => {
            const token = sessions.issue(grant)
            return {
              launch: { ...mcpCommand, secretEnv: { [MCP_URL_ENV]: baseUrl, [MCP_TOKEN_ENV]: token } },
              release: () => sessions.revoke(token),
            }
          },
        }
      : {}),
  })
  const workflowStore = createWorkflowStore(root)
  const memory = createMemoryStore(root)
  const workflows = { store: workflowStore, runner: createWorkflowRunner(workflowStore, manager, store) }
  const remoteStore = createRemoteStore(root)
  const push = createPushStore(root)
  const remote = createRemoteAccess({ store: remoteStore, tailscale: options.remote?.tailscale ?? systemTailscale,
    serveStatic: (pathname, res) => serveStatic(options.webDist, pathname, res), port: options.remote?.port,
    push, ...(options.remote?.sendPush ? { sendPush: options.remote.sendPush } : {}) })
  const stopNotifier = startNotifier({ push, manager, threads: store,
    active: () => remote.status().running,
    paired: (deviceId) => remoteStore.devices().some((d) => d.id === deviceId),
    projectName: (path) => projects.list({ includeHidden: true }).find((p) => p.path === path)?.name ?? path.split('/').pop() ?? path,
    ...(options.remote?.sendPush ? { send: options.remote.sendPush } : {}) })
  const server = createServer()

  const listen = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  if (options.preferredPort) {
    try {
      await listen(options.preferredPort)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      await listen(options.port)
    }
  } else await listen(options.port)

  // The API guard needs the real port, which is only known after listen when port is 0.
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://${host}:${port}`
  const openUrl = options.openUrl ?? openWithSystem
  const agents = createAgentStatus(store, options.agentProbe)
  const api = createApiHandler({ manager, store, projects, processes, workflows, remote, agents, memory, importHome: process.env.COCKPIT_IMPORT_HOME, mcp: { sessions, processes, openUrl, workflows: workflows.store, memory } }, [port, ...(options.trustedPorts ?? [])])
  remote.attach(api)
  server.on('request', (req, res) => {
    void api(req, res).then((handled) => {
      if (!handled) serveStatic(options.webDist, new URL(req.url ?? '/', 'http://localhost').pathname, res)
    })
  })

  workflows.runner.start()
  await remote.resume()

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      workflows.runner.close()
      stopNotifier()
      await Promise.all([manager.shutdown(), processes.shutdown(), remote.close()])
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })()
    return closing
  }

  return { url: `http://${host}:${port}`, port, store, manager, processes, remote, projects, close }
}
