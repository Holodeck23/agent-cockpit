import { createBrowserAgent, type BrowserHost } from './browser/agent.ts'
import { createBrowserLeases, type BrowserLeases } from './browser/agent-policy.ts'
import { createConversationControl } from './mcp/control.ts'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorkflowStore } from './workflows/store.ts'
import { createWorkflowRunner } from './workflows/runner.ts'
import { createApiHandler } from './http/router.ts'
import { createAgentStatus, fixedCapabilities, type VersionProbe } from './agents/status.ts'
import { createCapabilityService, type CapabilityService } from './agents/capabilities/service.ts'
import { createAgyMcp } from './projects/agy-mcp.ts'
import { createLifecycle, type Lifecycle, type LifecycleOptions } from './agents/lifecycle/service.ts'
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
import { createPhonePreviews, previewOrigins, type PhonePreviews } from './remote/preview/control.ts'
import type { ListenerGroups } from './remote/preview/upstream.ts'
import type { PreviewCapture, PreviewOpen } from './preview/types.ts'

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
  readonly openUrl?: (preview: PreviewOpen) => Promise<void> | void
  /** Captures a local preview for an agent to inspect. Available in the desktop shell. */
  readonly capturePreview?: (url: string) => Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }>
  /** inspect_preview on the conversation's own page (desktop app, W9-11); capturePreview stays for result evidence. */
  readonly inspectPreview?: (preview: PreviewOpen) => Promise<PreviewCapture>
  /** Phone access: the Tailscale CLI to drive (a fake in tests) and a port override (0 = any free port). */
  readonly remote?: {
    readonly tailscale?: Tailscale; readonly port?: number; readonly sendPush?: PushSender
    /** Phone preview listeners on any free port (0) instead of their fixed ones, and who holds a port (tests). */
    readonly previewListenPort?: number; readonly listenerGroups?: ListenerGroups
  }
  /** How agent CLIs are checked for the picker; a fake in tests. */
  readonly agentProbe?: VersionProbe
  /** The capability cache (W10.1); a fixture in tests. Defaults to probing the CLIs on PATH. */
  readonly capabilities?: CapabilityService
  /**
   * The desktop app's per-launch key: every desktop /api request must carry it (guard.ts).
   * Without it, any local process can use the API, which only `npm start` should allow.
   */
  readonly windowKey?: string
  /** The in-app browser's pages (desktop app only), read when an agent calls a browser tool. */
  readonly browserHost?: () => BrowserHost | undefined
  /** Where official installers are read from; a proof build's local stand-ins (never a release build). */
  readonly installerDownload?: LifecycleOptions['download']
}

function openWithSystem({ url }: PreviewOpen): Promise<void> {
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
  /** Phone previews (H5): per-app origins, tickets and their Tailscale entries. */
  readonly phonePreviews: PhonePreviews
  /** Known project folders; the desktop shell checks these before opening one in Finder. */
  readonly projects: ProjectStore
  /** Records each run's before/after workspace observations; tests settle it before reading. */
  readonly runObserver: RunObserver
  /** Durable result cards and finite host checks (pilot 10.1). */
  readonly results: ResultService
  readonly checks: CheckRunner
  /** Agents' browser grants; the desktop shell revokes a page's grants when the page goes away. */
  readonly browserLeases: BrowserLeases
  /** Whether an agent is using a browser page now (a call, or a grant of a live run). */
  browserInUse(pageKey: string): boolean
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

/**
 * The page renders text agents and repositories write (replies, Markdown documents, file names).
 * React escapes it; this is the second line: no script, frame or image from anywhere but Cockpit
 * itself (and local previews in frames), so a hostile Markdown image cannot beacon out or reach the LAN.
 */
export const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React style attributes and the editor's injected styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  'frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*',
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The page as the phone gets it: View app posts a one-use ticket to the app's own preview origin
 * (W11.2), so those origins, and only those, are allowed form targets. Nothing may frame it.
 */
export function phonePagePolicy(hostname: string): string {
  return PAGE_POLICY.replace("form-action 'self'", ["form-action 'self'", ...previewOrigins(hostname)].join(' '))
}

function serveStatic(webDist: string, pathname: string, res: ServerResponse, policy = PAGE_POLICY): void {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(webDist, safe)
  if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(webDist, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('Web UI not built. Run `npm run build`, or use `npm run dev:web` during development.')
    return
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...(type.startsWith('text/html') ? { 'content-security-policy': policy } : {}) })
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
  // Tests that fake the version check get a fixed record: no real CLI is run.
  const capabilities = options.capabilities ?? (options.agentProbe ? fixedCapabilities(options.agentProbe) : createCapabilityService())
  const agyMcp = createAgyMcp(projects, options.mcp)
  // Created after the manager it watches; the manager asks it before starting a session.
  let lifecycle: Lifecycle | undefined
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
    capabilities,
    antigravityMcp: (projectPath) => agyMcp.prepare(projectPath),
    launchGate: (agent) => lifecycle?.launchBlock(agent),
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
  lifecycle = createLifecycle({ stateRoot: root, capabilities, ...(options.installerDownload ? { download: options.installerDownload } : {}), sessions: { activity: (agent) => manager.agentActivity(agent), closeIdle: (agent) => manager.closeIdleSessions(agent) } })
  const agentLifecycle = lifecycle
  // A waiting update starts as soon as the last conversation on that CLI stops working.
  manager.subscribe(() => agentLifecycle.activityChanged())
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
  const tailscale = options.remote?.tailscale ?? systemTailscale
  const remote = createRemoteAccess({ store: remoteStore, tailscale,
    serveStatic: (pathname, res) => {
      const hostname = remote.previewPolicy()?.hostname
      serveStatic(options.webDist, pathname, res, hostname ? phonePagePolicy(hostname) : PAGE_POLICY)
    }, port: options.remote?.port,
    push, ...(options.remote?.sendPush ? { sendPush: options.remote.sendPush } : {}) })
  const previewListenPort = options.remote?.previewListenPort
  const phonePreviews = createPhonePreviews({ root, remoteStore, tailscale, processes, policy: () => remote.previewPolicy(),
    ...(previewListenPort !== undefined ? { listenPort: () => previewListenPort } : {}),
    ...(options.remote?.listenerGroups ? { listenerGroups: options.remote.listenerGroups } : {}),
    log: (line) => console.log(`[cockpit] ${line}`) })
  remote.attachPreviews(phonePreviews)
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
  const agents = createAgentStatus(store, capabilities, options.agentProbe ? () => join(store.root, 'no-chrome-helper.json') : undefined)
  const browserLeases = createBrowserLeases()
  const browser = options.browserHost ? createBrowserAgent({
    host: options.browserHost,
    leases: browserLeases,
    cockpitPorts: () => [port, ...(remote.port() ? [remote.port()!] : [])],
    // Only while the conversation is working and Stop has not been pressed.
    currentRun: (threadId) => (manager.canControl(threadId) ? manager.currentRunId(threadId) : undefined),
    approve: (grant, toolName, input, approval, signal) => manager.requestHostAction(grant.threadId, toolName, input, signal, approval),
  }) : undefined
  const api = createApiHandler({ manager, store, projects, workspaces, processes, workflows, remote, phonePreviews, agents, capabilities, agyMcp, lifecycle: agentLifecycle, memory, presets, runs, results, checks, observingRun: runObserver.observing, importHome: process.env.COCKPIT_IMPORT_HOME,
    mcp: { sessions, processes, openUrl,
      processOwner: (threadId) => {
        const meta = manager.summaries().find((t) => t.meta.id === threadId)?.meta
        const runId = manager.currentRunId(threadId)
        return { kind: 'conversation', threadId, title: meta?.title ?? 'Deleted conversation', ...(runId ? { runId } : {}) }
      }, conversations: { manager, store }, control: createConversationControl({ manager, store }, agents), ...(options.capturePreview ? { capturePreview: options.capturePreview } : {}), ...(options.inspectPreview ? { inspectPreview: options.inspectPreview } : {}), workflows: workflows.store, memory,
      agentWorkflows: agentWorkflowsAllowed, enableWorkflow: (id) => workflows.runner.setEnabled(id, true),
      approve: (grant, toolName, input, approval, signal) => manager.requestHostAction(grant.threadId, toolName, input, signal, approval),
      cockpitPorts: () => [port, ...(remote.port() ? [remote.port()!] : [])], ...(browser ? { browser } : {}) } },
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
      await Promise.all([manager.shutdown(), processes.shutdown(), remote.close(), phonePreviews.dispose(), checks.shutdown(), agentLifecycle.shutdown()])
      runObserver.stop()
      await runObserver.settle()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })()
    return closing
  }

  return { url: `http://${host}:${port}`, port, store, manager, processes, remote, phonePreviews, projects, runObserver, results, checks, browserLeases, browserInUse: (key) => browser?.inUse(key) ?? false, close }
}
