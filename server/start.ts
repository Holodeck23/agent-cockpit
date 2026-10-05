import { createConversationControl } from './mcp/control.ts'
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
import { createWorkspaceStore } from './projects/workspaces.ts'
import { createPresetStore } from './presets/store.ts'
import { createMemoryStore } from './memory/store.ts'
import { createThreadManager, type ThreadManager, type ManagerOptions } from './threads/manager.ts'
import { createRunObservationStore, observeRuns, type RunObserver } from './runs/observations.ts'
import { createResultStore } from './results/store.ts'
import { createCheckRunner, type CheckRunner } from './results/checks.ts'
import { createResultService, type ResultService } from './results/service.ts'
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
  /** Opens a preview for the user; defaults to macOS `open`. The app retargets this to its preview pane. */
  readonly openUrl?: (url: string) => Promise<void> | void
  /** Captures a local preview for an agent to inspect. Available in the desktop shell. */
  readonly capturePreview?: (url: string) => Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }>
  /** Phone access: the Tailscale CLI to drive (a fake in tests) and a port override (0 = any free port). */
  readonly remote?: { readonly tailscale?: Tailscale; readonly port?: number; readonly sendPush?: PushSender }
  /** How agent CLIs are checked for the picker; a fake in tests. */
  readonly agentProbe?: VersionProbe
  /**
   * The desktop app's per-launch key: every desktop /api request must carry it (guard.ts).
   * Without it, any local process can use the API, which only `npm start` should allow.
   */
  readonly windowKey?: string
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
  /** Records each run's before/after workspace observations; tests settle it before reading. */
  readonly runObserver: RunObserver
  /** Durable result cards and finite host checks (pilot 10.1). */
  readonly results: ResultService
  readonly checks: CheckRunner
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
  const workspaces = createWorkspaceStore(root)
  const processes = createProcessRunner({ ledgerFile: join(root, 'processes.json') })
  const sessions = createMcpSessions()
  // Known once listening; sessions only start after that.
  let baseUrl = ''
  const mcpCommand = options.mcp
  const agentWorkflowsAllowed = (projectPath: string): boolean =>
    projects.list({ includeHidden: true }).find((p) => p.path === projectPath)?.agentWorkflows === true
  const manager = createThreadManager(store, {
    workspaceFor: (projectPath) => {
      try {
        workspaces.ensure([projectPath])
        return workspaces.primaryFor(projectPath)?.workspace.id
      } catch (error) {
        console.warn('[cockpit] no workspace identity:', error instanceof Error ? error.message : error)
        return undefined
      }
    },
    instructions: (projectPath) => {
      const project = projects.list({ includeHidden: true }).find((p) => p.path === projectPath)
      return project?.instructions ? { text: project.instructions, revision: project.instructionsRevision ?? 0 } : undefined
    },
    ...(options.launchers ? { launchers: options.launchers } : {}),
    ...(mcpCommand
      ? {
          mcp: (grant) => {
            const token = sessions.issue(grant)
            // Read when the session starts: a changed setting applies to the next agent session.
            const alsoAllowed = agentWorkflowsAllowed(grant.projectPath) ? ['save_workflow'] : []
            return {
              launch: { ...mcpCommand, secretEnv: { [MCP_URL_ENV]: baseUrl, [MCP_TOKEN_ENV]: token }, alsoAllowed },
              release: () => sessions.revoke(token),
            }
          },
        }
      : {}),
  })
  const runs = createRunObservationStore(root)
  const runObserver = observeRuns(manager, runs)
  const resultStore = createResultStore(root)
  const checks = createCheckRunner(resultStore)
  const results = createResultService({
    store: resultStore, checks, runs, observing: runObserver.observing,
    ...(options.capturePreview ? { capturePreview: options.capturePreview } : {}),
  })
  const workflowStore = createWorkflowStore(root)
  // A crash left these runs open: they end as interrupted; nothing is relaunched or replayed (ID-07).
  const interrupted = manager.recoverInterrupted()
  if (interrupted.length > 0) console.warn(`[cockpit] marked ${interrupted.length} unfinished run(s) as interrupted`)
  // Additive identity migration: registers every folder Cockpit already knows; rewrites no legacy file.
  try {
    workspaces.ensure([...projects.list({ includeHidden: true }).map((p) => p.path), ...store.list().map((m) => m.projectPath), ...workflowStore.list().map((w) => w.projectPath)])
  } catch (error) {
    console.warn('[cockpit] workspace identities not registered:', error instanceof Error ? error.message : error)
  }
  const memory = createMemoryStore(root)
  const presets = createPresetStore(root)
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
  const api = createApiHandler({ manager, store, projects, workspaces, processes, workflows, remote, agents, memory, presets, runs, results, checks, observingRun: runObserver.observing, importHome: process.env.COCKPIT_IMPORT_HOME,
    mcp: { sessions, processes, openUrl,
      processOwner: (threadId) => {
        const meta = manager.summaries().find((t) => t.meta.id === threadId)?.meta
        const runId = manager.currentRunId(threadId)
        return { kind: 'conversation', threadId, title: meta?.title ?? 'Deleted conversation', ...(runId ? { runId } : {}) }
      }, conversations: { manager, store }, control: createConversationControl({ manager, store }, agents), ...(options.capturePreview ? { capturePreview: options.capturePreview } : {}), workflows: workflows.store, memory,
      agentWorkflows: agentWorkflowsAllowed, enableWorkflow: (id) => workflows.runner.setEnabled(id, true) } },
  [port, ...(options.trustedPorts ?? [])], options.windowKey)
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
      await Promise.all([manager.shutdown(), processes.shutdown(), remote.close(), checks.shutdown()])
      runObserver.stop()
      await runObserver.settle()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })()
    return closing
  }

  return { url: `http://${host}:${port}`, port, store, manager, processes, remote, projects, runObserver, results, checks, close }
}
