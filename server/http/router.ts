import { createRecovery, resumeRecoveryBody } from '../onboarding/recovery.ts'
import { automaticAgent, directorDismissed, dismissDirector, ORIENTATION_PROMPT, prepareSample } from '../onboarding/director.ts'
import { expandFiles, listFiles, readProjectFile } from '../files/browser.ts'
import { MessageReferenceError } from '../files/references.ts'
import { FileConflictError, writeProjectFile } from '../files/editor.ts'
import { checkReferences, searchFiles } from '../files/search.ts'
import { documentsFolder, listDocuments, markDocument, renameFile, searchDocuments, setDocumentsFolder, spaceRoot, spaceSchema } from '../files/documents.ts'
import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { ProcessConflictError, type ProcessRunner } from '../processes/runner.ts'
import { projectPatchSchema, type Project, type ProjectStore } from '../projects/store.ts'
import type { WorkspaceStore } from '../projects/workspaces.ts'
import { createWorkspaceScope } from './workspace-scope.ts'
import { isRefusal, workspaceFolder } from '../projects/resolve.ts'
import { ImageError, readProjectImage, removeProjectImages, saveProjectImage } from '../projects/images.ts'
import { MAX_MEMORY_CHARS, MemoryReadError, memoryScope, type MemoryStore } from '../memory/store.ts'
import { StoreReadError } from '../state/read-error.ts'
import { workflowTitle } from '../workflows/title.ts'
import { listSessions } from '../import/sessions.ts'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ChooseWorkspaceError, HandoffChangedError, OperationConflictError, ThreadBusyError, WorkspaceUnavailableError, type ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { threadSettingsSchema } from '../threads/types.ts'
import { MAX_QUERY, searchThreads } from '../threads/search.ts'
import { createImageStore, IMAGE_FILE, ImageAttachError, MAX_ATTACHED_IMAGE_BYTES } from '../threads/images.ts'
import type { IncomingImage } from '../threads/manager.ts'
import { hasWindowKey, isTrustedRequest } from './guard.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { handleGitRoute } from './git-routes.ts'
import type { RunObservationStore } from '../runs/observations.ts'
import type { CheckRunner } from '../results/checks.ts'
import type { ResultService } from '../results/service.ts'
import type { PresetStore } from '../presets/store.ts'
import { handleMcpRoute, type McpRouteDeps } from './mcp-routes.ts'
import { handleProcessRoute } from './process-routes.ts'
import { handleWorkflowRoute, type WorkflowDeps } from './workflow-routes.ts'
import { handleResultRoute } from './result-routes.ts'
import { resolveWorkflows } from '../workflows/store.ts'
import type { WorkflowSnapshot } from '../agents/types.ts'
import { openSse } from './sse.ts'
import type { RemoteAccess } from '../remote/service.ts'
import type { PhonePreviews } from '../remote/preview/control.ts'
import type { AgentStatus } from '../agents/status.ts'
import type { CapabilityService } from '../agents/capabilities/service.ts'
import { AGENT_IDS } from '../agents/capabilities/types.ts'
import type { AgyMcp } from '../projects/agy-mcp.ts'
import type { Lifecycle } from '../agents/lifecycle/service.ts'
import { handleAgentLifecycleRoute, isAgentLifecycleRoute } from './agent-lifecycle-routes.ts'
import { handleAccountRoute, isAccountRoute } from './account-routes.ts'
import { handleWorkspaceRoute, isWorkspaceRoute } from './workspace-routes.ts'
import type { AccountService } from '../agents/accounts/service.ts'
import type { WorktreeService } from '../projects/worktrees.ts'
import type { WorktreeLifecycle } from '../projects/worktree-lifecycle.ts'
import { isBusy } from '../threads/status.ts'

/** Images one message may carry (I1/I2), as base64; the store checks what they really are. */
export const MAX_MESSAGE_IMAGES = 8
const messageImages = z.array(z.union([
  z.object({
    data: z.string().min(1).max(Math.ceil(MAX_ATTACHED_IMAGE_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    name: z.string().max(200).optional(),
  }),
  // An image this conversation already holds (Retry, a taken-back message's chips), by its stored name.
  z.object({ stored: z.string().max(80), name: z.string().max(200).optional() }),
])).max(MAX_MESSAGE_IMAGES).optional()
/** Room for a full set of images on the two routes that take them; every other route keeps 1 MB. */
const IMAGE_BODY_BYTES = MAX_MESSAGE_IMAGES * (Math.ceil(MAX_ATTACHED_IMAGE_BYTES / 3) * 4 + 1024) + 1_000_000
/** `stored` images are read from `threadId`'s own images; a new conversation has none to name. */
const decodeImages = (images: z.infer<typeof messageImages>, read?: (file: string) => Buffer | undefined): IncomingImage[] =>
  (images ?? []).map((image) => {
    const name = image.name ? { name: image.name } : {}
    if ('data' in image) return { bytes: Buffer.from(image.data, 'base64'), ...name }
    const bytes = IMAGE_FILE.test(image.stored) ? read?.(image.stored) : undefined
    if (!bytes) throw new ImageAttachError('That image is not in this conversation any more; add it again')
    return { bytes, ...name }
  })
const createThreadBody = z.object({
  projectPath: z.string().min(1).max(1000),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(200_000),
  settings: threadSettingsSchema.default(threadSettingsSchema.parse({})),
  images: messageImages,
  /** Start in this worktree (or the primary) instead of the project's primary. */
  workspaceId: z.uuid().optional(),
})
/** `operationId`: one per send attempt, so a repeated request is answered once (ID-05). */
const messageBody = z.object({ text: z.string().min(1).max(200_000), images: messageImages, operationId: z.uuid().optional(), workspaceId: z.uuid().optional() })
const approvalBody = z.object({ behavior: z.enum(['allow', 'allow_session', 'deny']) })
/** No answers closes the questions unanswered. */
const questionBody = z.object({ answers: z.record(z.string().max(500), z.string().max(4000)).optional() })
const completedBody = z.object({ completed: z.boolean() })
/** What happens to the running processes a deleted conversation owns (K2). */
const deleteThreadBody = z.object({ processes: z.enum(['stop', 'keep']).optional() })
const checkReferencesBody = z.object({ projectPath: z.string().min(1).max(1000).optional(), workspaceId: z.uuid().optional(), text: z.string().max(200_000) })
const writeFileBody = z.object({
  projectPath: z.string().min(1).max(1000).optional(),
  /** Files of a worktree: the workspace's folder is the root. Either this or projectPath. */
  workspaceId: z.uuid().optional(),
  path: z.string().min(1).max(1000),
  text: z.string().max(200_000),
  /** The version the edit started from; null creates a new file. */
  expected: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** The repository, or the app's own documents folder for the project. */
  space: spaceSchema,
})
const renameBody = z.object({ projectPath: z.string().min(1).max(1000).optional(), workspaceId: z.uuid().optional(), path: z.string().min(1).max(1000), name: z.string().min(1).max(255), space: spaceSchema })
const markBody = z.object({ projectPath: z.string().min(1).max(1000), path: z.string().min(1).max(255), pinned: z.boolean().optional(), archived: z.boolean().optional() })
const switchBody = z.object({ settings: threadSettingsSchema })
/** A switch names the handoff the user reviewed (D13): sha256 of the previewed text. */
const agentSwitchBody = switchBody.extend({ handoff: z.string().regex(/^[0-9a-f]{64}$/) })
const projectBody = projectPatchSchema.extend({ path: z.string().min(1).max(1000) })
// A data: URL is about 4/3 of the file; the 512 KB limit itself is checked after decoding.
const imageBody = z.object({ path: z.string().min(1).max(1000), image: z.string().max(750_000).nullable() })

function assertDirectory(path: string): void {
  try {
    if (statSync(path).isDirectory()) return
  } catch {
    // fall through
  }
  throw new HttpError(400, `Not a folder on this computer: ${path}`)
}

export interface ApiDeps {
  readonly workflows: WorkflowDeps
  readonly manager: ThreadManager
  readonly store: ThreadStore
  readonly projects: ProjectStore
  /** Opaque project/workspace identity (G-IDENTITY). Absent in tests that do not need it. */
  readonly workspaces?: WorkspaceStore
  readonly processes: ProcessRunner
  readonly mcp: McpRouteDeps
  readonly remote: RemoteAccess
  /** Phone previews' desktop routes (/api/phone/previews); the phone's ticket route is on the phone listener. */
  readonly phonePreviews?: Pick<PhonePreviews, 'handleLocal' | 'retireProject'>
  /** Installation and last reported usage per agent, for the agent picker. */
  readonly agents?: () => Promise<AgentStatus[]>
  /** Typed capability records per agent (W10.1); desktop only. */
  readonly capabilities?: CapabilityService
  /** P3: per-project Antigravity access to Cockpit's tools; desktop only. */
  readonly agyMcp?: AgyMcp
  /** Install, update and sign-in for agent CLIs (W10.2/W10.3); desktop only. */
  readonly lifecycle?: Lifecycle
  /** Account profiles and each project's choice per agent (W12.1); desktop only. */
  readonly accounts?: AccountService
  /** Worktree workspaces (M1, W12.2); desktop only. */
  readonly worktrees?: WorktreeService
  /** Remove, archive, restore and Git's view of registered worktrees (W12.4); desktop only. */
  readonly worktreeLifecycle?: WorktreeLifecycle
  readonly memory?: MemoryStore
  /** Named agent settings for the picker. */
  readonly presets?: PresetStore
  /** Where the CLIs keep their sessions (~), for Import conversations; tests point it elsewhere. */
  readonly importHome?: string
  /** Each run's before/after workspace observations (W7-05). */
  readonly runs?: RunObservationStore
  /** Durable run results and finite host checks (desktop mutations, scoped reads). */
  readonly results?: ResultService
  readonly checks?: CheckRunner
  readonly observingRun?: (runId: string) => boolean
}

/**
 * Each project with its opaque IDs. An unreadable workspaces.json leaves them off (and is reported)
 * rather than hiding the projects; features that need an ID refuse on their own.
 */
function withIdentity(list: readonly Project[], workspaces: WorkspaceStore | undefined): Array<Project & { projectId?: string; workspaceId?: string }> {
  if (!workspaces) return [...list]
  try {
    workspaces.ensure(list.map((p) => p.path))
    return list.map((p) => {
      const found = workspaces.primaryFor(p.path)
      return found ? { ...p, projectId: found.project.id, workspaceId: found.workspace.id } : p
    })
  } catch (error) {
    console.warn('[cockpit]', error instanceof Error ? error.message : error)
    return [...list]
  }
}

export function createApiHandler({ manager, store, projects, workspaces, worktreeLifecycle, processes, mcp, workflows, remote, phonePreviews, agents, capabilities, agyMcp, lifecycle, accounts, worktrees, memory, presets, runs, results, checks, observingRun, importHome = homedir() }: ApiDeps, allowedPorts: readonly number[], windowKey?: string) {
  const recovery = createRecovery({ store, manager, importHome, agents: agents ?? (async () => []) })
  const images = createImageStore(store.root)
  const scope = createWorkspaceScope(projects, workspaces)
  // The agent gets attachments and workflow instructions inlined; the thread keeps what the user wrote.
  // The workflows used are kept with the message, as they were at send time.
  // @file attachments come from the workspace the message works in (`folder`); workflows stay the project's.
  const expandedFor = (text: string, projectPath: string, folder: string = projectPath): { agentText: string; workflows?: WorkflowSnapshot[] } => {
    const resolved = resolveWorkflows(text, projectPath, workflows.store)
    return { agentText: expandFiles(resolved.text, folder), ...(resolved.used.length ? { workflows: resolved.used } : {}) }
  }

  /** `viaPhone` requests were already checked by the phone listener (remote/service.ts). */
  return async (req: IncomingMessage, res: ServerResponse, viaPhone = false): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api') return false
    const method = req.method ?? 'GET'

    if (!viaPhone && !isTrustedRequest(req, allowedPorts)) {
      sendJson(res, 403, { error: 'Request did not come from the cockpit page' })
      return true
    }
    // In the desktop app only the Cockpit window holds the key. /api/mcp has its own per-session
    // token (the agent's MCP server calls it from Node), and phone requests are checked by the phone listener.
    if (!viaPhone && windowKey !== undefined && parts[1] !== 'mcp' && !hasWindowKey(req, windowKey)) {
      sendJson(res, 403, { error: 'Request did not come from the Cockpit window' })
      return true
    }

    try {
      if (method === 'GET' && parts[1] === 'stream') {
        openSse(req, res, manager, processes, viaPhone ? undefined : remote)
        return true
      }
      if (parts[1] === 'recovery' && parts.length === 2) {
        if (viaPhone) throw new HttpError(403, 'Recent-work recovery is only available on the Mac')
        const body = method === 'POST' ? parseBody(resumeRecoveryBody, await readJson(req)) : undefined
        const projectPath = body?.projectPath ?? url.searchParams.get('projectPath') ?? ''
        if (!projects.list().some((p) => p.path === projectPath)) throw new HttpError(404, 'Open this project first')
        assertDirectory(projectPath)
        if (method === 'GET') sendJson(res, 200, { data: await recovery.discover(projectPath) })
        else if (body) sendJson(res, 200, { data: await recovery.resume(body) })
        else throw new HttpError(404, 'Not found')
        return true
      }
      if (parts[1] === 'onboarding') {
        if (viaPhone) throw new HttpError(403, 'First-run setup is only available on the Mac')
        if (method === 'GET' && parts.length === 2) {
          const show = !directorDismissed(store.root) && projects.list({ includeHidden: true }).length === 0 && store.list().length === 0
          sendJson(res, 200, { data: { show } })
          return true
        }
        if (method === 'POST' && parts[2] === 'dismiss' && parts.length === 3) {
          dismissDirector(store.root)
          sendJson(res, 200, { data: {} })
          return true
        }
        if (method === 'POST' && parts[2] === 'start' && parts.length === 3) {
          const body = parseBody(z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('project'), projectPath: z.string().min(1).max(1000) }),
            z.object({ kind: z.literal('sample') }),
          ]), await readJson(req))
          const agent = automaticAgent(await agents?.() ?? [], store.list(), body.kind === 'sample')
          if (!agent) throw new HttpError(409, body.kind === 'sample'
            ? 'The sample needs Claude Code, Codex or OpenCode installed and signed in. You can still open a project or skip.'
            : 'Install and sign in to a supported agent, then try again. You can also skip for now.')
          const { projectPath, text } = body.kind === 'sample' ? prepareSample(store.root) : { projectPath: body.projectPath, text: ORIENTATION_PROMPT }
          assertDirectory(projectPath)
          const visibleText = body.kind === 'sample' ? 'Start the sample app, show me the preview, and suggest one small change I could try.' : 'Explore this project and suggest a useful next step. Leave the files unchanged.'
          const meta = manager.create({ projectPath, text: visibleText, agentText: text, title: body.kind === 'sample' ? 'Your first flight' : 'Pick up where you left off', settings: { agent, permissionMode: 'manual', useHooks: false } })
          projects.open(projectPath, { pinned: true, ...(body.kind === 'sample' ? { name: '90-second sample' } : {}) })
          sendJson(res, 201, { data: meta })
          return true
        }
        throw new HttpError(404, 'Not found')
      }
      if (parts[1] === 'agents' && parts.length === 2 && method === 'GET' && agents) {
        sendJson(res, 200, { data: await agents() })
        return true
      }
      // Installers, updaters and sign-in helpers run on the Mac and are started from it only.
      if (isAgentLifecycleRoute(parts) && lifecycle) {
        if (viaPhone) throw new HttpError(403, 'Installing, updating and signing in to agents is only available on the Mac')
        await handleAgentLifecycleRoute(req, res, parts, lifecycle)
        return true
      }
      // Accounts name who is signed in where: the Mac only (INTERFACES §4).
      if (isAccountRoute(parts) && accounts) {
        if (viaPhone) throw new HttpError(403, 'Accounts are only available on the Mac')
        await handleAccountRoute(req, res, url, parts, accounts, (projectId) => {
          const known = workspaces?.list().projects.find((p) => p.id === projectId)?.path
          return known && projects.list().some((p) => p.path === known) ? known : undefined
        })
        return true
      }
      // Workspaces name folders and branches; creating one changes the repository: the Mac only (INTERFACES §4).
      if (isWorkspaceRoute(parts) && workspaces && worktrees) {
        if (viaPhone) throw new HttpError(403, 'Workspaces are only available on the Mac')
        await handleWorkspaceRoute(req, res, parts, workspaces, worktrees, (projectId) => {
          const known = workspaces.list().projects.find((p) => p.id === projectId)?.path
          return known !== undefined && projects.list().some((p) => p.path === known)
        }, worktreeLifecycle)
        return true
      }
      // Capabilities name executable paths and sign-in state: the Mac only (INTERFACES §4).
      if (parts[1] === 'agents' && parts[3] === 'capabilities' && capabilities) {
        if (viaPhone) throw new HttpError(403, 'Agent capabilities are only available on the Mac')
        const agent = AGENT_IDS.find((id) => id === parts[2])
        if (!agent) throw new HttpError(404, 'Unknown agent')
        if (parts.length === 4 && method === 'GET') {
          sendJson(res, 200, { data: await capabilities.get(agent) })
          return true
        }
        if (parts.length === 5 && parts[4] === 'refresh' && method === 'POST') {
          sendJson(res, 200, { data: await capabilities.get(agent, { refresh: true }) })
          return true
        }
        throw new HttpError(404, 'Not found')
      }
      if (parts[1] === 'files' && parts[2] === 'write' && method === 'PUT') {
        if (viaPhone) throw new HttpError(403, 'Editing files is only available on the Mac')
        const body = parseBody(writeFileBody, await readJson(req))
        const at = scope.resolve(body.projectPath, body.workspaceId)
        try {
          sendJson(res, 200, { data: writeProjectFile(body.space === 'documents' ? spaceRoot(store.root, at.projectPath, 'documents') : at.cwd, body.path, body.text, body.expected) })
        } catch (error) {
          throw new HttpError(error instanceof FileConflictError ? 409 : 400, error instanceof Error ? error.message : String(error))
        }
        return true
      }
      if (parts[1] === 'files' && parts[2] === 'rename' && method === 'POST') {
        if (viaPhone) throw new HttpError(403, 'Renaming files is only available on the Mac')
        const body = parseBody(renameBody, await readJson(req))
        const at = scope.resolve(body.projectPath, body.workspaceId)
        // Documents and their pin marks are the project's; a project file is renamed inside the workspace's folder.
        try { sendJson(res, 200, { data: { path: renameFile(store.root, body.space === 'documents' ? at.projectPath : at.cwd, body.space, body.path, body.name) } }) }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
        return true
      }
      // The Memory view: read, add, edit, delete and clear. Your own entries are marked as from you.
      if (parts[1] === 'memory' && memory) {
        if (viaPhone) throw new HttpError(403, 'Memory is only available on the Mac')
        const known = (path: string): void => { if (!projects.list().some((p) => p.path === path)) throw new HttpError(404, 'Open this project first') }
        const text = z.string().trim().min(1).max(MAX_MEMORY_CHARS)
        try {
          if (parts.length === 2 && method === 'GET') {
            const projectPath = url.searchParams.get('projectPath') ?? ''
            known(projectPath)
            sendJson(res, 200, { data: memory.list(projectPath) })
            return true
          }
          if (parts.length === 2 && method === 'POST') {
            const body = parseBody(z.object({ projectPath: z.string().min(1).max(1000), scope: memoryScope, text }), await readJson(req))
            known(body.projectPath)
            sendJson(res, 201, { data: memory.add({ ...body, source: { kind: 'you' } }) })
            return true
          }
          if (parts[2] === 'clear' && method === 'POST') {
            const { projectPath } = parseBody(z.object({ projectPath: z.string().min(1).max(1000) }), await readJson(req))
            known(projectPath)
            sendJson(res, 200, { data: { removed: memory.clearProject(projectPath) } })
            return true
          }
          if (parts.length === 3 && method === 'POST') {
            sendJson(res, 200, { data: memory.update(parts[2]!, parseBody(z.object({ text }), await readJson(req)).text) })
            return true
          }
          if (parts.length === 3 && method === 'DELETE') {
            memory.remove(parts[2]!)
            sendJson(res, 200, { data: { removed: parts[2] } })
            return true
          }
        } catch (error) {
          if (error instanceof HttpError || error instanceof MemoryReadError) throw error
          throw new HttpError(400, error instanceof Error ? error.message : String(error))
        }
      }
      // Import conversations: the project's own Claude Code and Codex sessions, read-only.
      if (parts[1] === 'import' && parts.length === 2) {
        if (viaPhone) throw new HttpError(403, 'Importing is only available on the Mac')
        const known = new Set(store.list().map((m) => `${m.settings.agent}:${m.sessionId}`))
        if (method === 'GET') {
          const projectPath = url.searchParams.get('projectPath') ?? ''
          if (!projects.list().some((p) => p.path === projectPath)) throw new HttpError(404, 'Open this project first')
          sendJson(res, 200, { data: listSessions(importHome, projectPath).map(({ events: _events, ...s }) => ({ ...s, inCockpit: known.has(`${s.agent}:${s.sessionId}`) })) })
          return true
        }
        if (method === 'POST') {
          const body = parseBody(z.object({ projectPath: z.string().min(1).max(1000), agent: z.enum(['claude', 'codex']), sessionId: z.string().min(1).max(200) }), await readJson(req))
          if (!projects.list().some((p) => p.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
          if (known.has(`${body.agent}:${body.sessionId}`)) throw new HttpError(409, 'That session is already a conversation in Cockpit')
          // Found again on disk, never from a path the page sends.
          const session = listSessions(importHome, body.projectPath).find((s) => s.agent === body.agent && s.sessionId === body.sessionId)
          if (!session) throw new HttpError(404, 'That session is not in this project')
          const now = new Date().toISOString()
          const meta = store.create({ id: randomUUID(), title: session.firstPrompt.slice(0, 80), projectPath: body.projectPath,
            settings: threadSettingsSchema.parse({ agent: session.agent }), sessionId: session.sessionId, sessionStarted: true,
            completed: false, createdAt: session.startedAt, updatedAt: now })
          for (const e of session.events) store.append(meta.id, e.event, e.ts)
          sendJson(res, 201, { data: meta })
          return true
        }
      }
      if (parts[1] === 'documents' && parts.length <= 3) {
        if (viaPhone) throw new HttpError(403, 'Your documents are only available on the Mac')
        if (method === 'GET' && parts.length === 2) {
          const projectPath = url.searchParams.get('projectPath') ?? ''
          if (!projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
          sendJson(res, 200, { data: listDocuments(store.root, projectPath) })
          return true
        }
        // Where this project's documents live (F14): Cockpit's folder, or one the user chose.
        if (parts[2] === 'location') {
          if (method === 'GET') {
            const projectPath = url.searchParams.get('projectPath') ?? ''
            if (!projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
            sendJson(res, 200, { data: documentsFolder(store.root, projectPath) })
            return true
          }
          if (method === 'POST') {
            const body = parseBody(z.object({ projectPath: z.string().min(1).max(1000), folder: z.string().min(1).max(1000).nullable() }), await readJson(req))
            if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
            try { sendJson(res, 200, { data: setDocumentsFolder(store.root, body.projectPath, body.folder) }) }
            catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
            return true
          }
        }
        if (method === 'GET' && parts[2] === 'search') {
          const projectPath = url.searchParams.get('projectPath') ?? ''
          if (!projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
          sendJson(res, 200, { data: searchDocuments(store.root, projectPath, (url.searchParams.get('q') ?? '').slice(0, 200)) })
          return true
        }
        if (method === 'POST' && parts[2] === 'mark') {
          const body = parseBody(markBody, await readJson(req))
          if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
          try { markDocument(store.root, body.projectPath, body.path, body) } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
          sendJson(res, 200, { data: listDocuments(store.root, body.projectPath) })
          return true
        }
      }
      if (parts[1] === 'files' && parts[2] === 'search' && method === 'GET') {
        const at = scope.resolve(url.searchParams.get('projectPath') ?? undefined, url.searchParams.get('workspaceId') ?? undefined)
        try { sendJson(res, 200, { data: searchFiles(at.cwd, (url.searchParams.get('q') ?? '').slice(0, 200)) }) }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
        return true
      }
      if (parts[1] === 'references' && parts[2] === 'check' && method === 'POST') {
        const body = parseBody(checkReferencesBody, await readJson(req))
        const at = scope.resolve(body.projectPath, body.workspaceId)
        sendJson(res, 200, { data: checkReferences(body.text, at.projectPath, workflows.store, at.cwd) })
        return true
      }
      if (parts[1] === 'files' && method === 'GET') {
        const at = scope.resolve(url.searchParams.get('projectPath') ?? undefined, url.searchParams.get('workspaceId') ?? undefined)
        const path = url.searchParams.get('path') ?? ''
        try {
          const space = spaceSchema.parse(url.searchParams.get('space') ?? undefined)
          if (space === 'documents' && viaPhone) throw new Error('Your documents are only available on the Mac')
          const base = space === 'documents' ? spaceRoot(store.root, at.projectPath, 'documents') : at.cwd
          const data = parts[2] === 'read' ? readProjectFile(base, path) : parts.length === 2 ? listFiles(base, path) : undefined
          if (!data) throw new Error('Unknown file action')
          sendJson(res, 200, { data })
        } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
        return true
      }
      if (parts[1] === 'remote') {
        await remote.handleLocal(req, res, parts)
        return true
      }
      if (parts[1] === 'phone' && parts[2] === 'previews') {
        if (viaPhone) throw new HttpError(403, 'Phone previews are set up on the Mac')
        if (!phonePreviews) throw new HttpError(404, 'Not found')
        await phonePreviews.handleLocal(req, res, parts)
        return true
      }
      if (parts[1] === 'workflows') {
        await handleWorkflowRoute(req, res, url, parts, workflows)
        return true
      }
      if (parts[1] === 'mcp') {
        await handleMcpRoute(req, res, url, parts, mcp)
        return true
      }
      if (parts[1] === 'presets' && parts.length === 2 && presets) {
        if (method === 'GET') { sendJson(res, 200, { data: presets.list() }); return true }
        if (method !== 'PUT') throw new HttpError(404, 'Not found')
        if (viaPhone) throw new HttpError(403, 'Presets can only be changed on the Mac')
        const body = (await readJson(req)) as { presets?: unknown }
        if (!Array.isArray(body?.presets)) throw new HttpError(400, 'Send { presets: [...] }')
        try { sendJson(res, 200, { data: presets.replace(body.presets) }) } catch (error) {
          throw new HttpError(400, error instanceof z.ZodError ? 'A preset needs a name, an agent and valid settings' : error instanceof Error ? error.message : String(error))
        }
        return true
      }
      if (parts[1] === 'git') {
        await handleGitRoute(req, res, url, parts, { projects, manager, scope, ...(runs ? { runs } : {}), ...(observingRun ? { observing: observingRun } : {}) }, viaPhone)
        return true
      }
      if ((parts[1] === 'runs' || parts[1] === 'checks') && results && checks) {
        await handleResultRoute(req, res, url, parts, {
          manager, store, results, checks, ...(workspaces ? { workspace: (id: string) => workspaces.get(id) } : {}),
          isOpen: (projectPath) => projects.list({ includeHidden: true }).some((project) => project.path === projectPath),
        }, viaPhone)
        return true
      }
      if (parts[1] === 'processes') {
        await handleProcessRoute(req, res, url, parts, processes, scope)
        return true
      }
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'image') {
        if (method === 'GET') {
          const project = projects.list().find((p) => p.path === url.searchParams.get('path'))
          const image = project?.image ? readProjectImage(store.root, project.image) : undefined
          if (!image) throw new HttpError(404, 'No picture')
          // Same-origin only: another site cannot probe which projects exist by loading their pictures (npm start has no window key).
          res.writeHead(200, { 'content-type': image.mime, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'" })
          res.end(image.bytes)
          return true
        }
        if (method === 'POST') {
          const body = parseBody(imageBody, await readJson(req))
          if (!projects.list().some((p) => p.path === body.path)) throw new HttpError(404, 'Open this project first')
          try {
            const name = body.image ? saveProjectImage(store.root, body.path, body.image) : undefined
            if (!name) removeProjectImages(store.root, body.path)
            sendJson(res, 200, { data: projects.setImage(body.path, name) })
          } catch (error) {
            if (error instanceof ImageError) throw new HttpError(400, error.message)
            throw error
          }
          return true
        }
      }
      // Project files pinned to the navigation.
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'pins' && method === 'POST') {
        if (viaPhone) throw new HttpError(403, 'Pins can only be changed on the Mac')
        const body = parseBody(z.object({ path: z.string().min(1).max(1000), files: z.array(z.string().min(1).max(1000)).max(100) }), await readJson(req))
        if (!projects.list().some((p) => p.path === body.path)) throw new HttpError(404, 'Open this project first')
        try { sendJson(res, 200, { data: projects.setPinnedFiles(body.path, body.files) }) }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
        return true
      }
      // Remove from Cockpit: the folder and its conversations stay; schedules there are paused.
      // P3: writes a plugin into the project folder, so the Mac only (W10-04).
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'agy-mcp' && method === 'POST' && agyMcp) {
        if (viaPhone) throw new HttpError(403, "Cockpit's tools for Antigravity can only be changed on the Mac")
        const body = parseBody(z.object({ path: z.string().min(1).max(1000), connected: z.boolean() }), await readJson(req))
        const result = agyMcp.setConnected(body.path, body.connected)
        if (!result.ok) throw new HttpError(result.code === 'unknown_project' ? 404 : result.code === 'unavailable' ? 503 : 409, result.message)
        sendJson(res, 200, { data: { project: result.project, ...(result.message ? { message: result.message } : {}), ...(result.backup ? { backup: result.backup } : {}) } })
        return true
      }
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'remove' && method === 'POST') {
        const { path } = parseBody(z.object({ path: z.string().min(1).max(1000) }), await readJson(req))
        if (!projects.list().some((p) => p.path === path)) throw new HttpError(404, 'Unknown project')
        const busy = manager.summaries().filter((t) => t.meta.projectPath === path && isBusy(t.status)).length
        if (busy > 0) throw new HttpError(409, `${busy === 1 ? 'A conversation' : `${busy} conversations`} in this project ${busy === 1 ? 'is' : 'are'} still working or waiting for you. Stop or answer ${busy === 1 ? 'it' : 'them'} first.`)
        const scheduled = workflows.store.list(path).filter((w) => w.enabled)
        for (const w of scheduled) workflows.store.update(w.id, { enabled: false, nextRunAt: null })
        const project = projects.hide(path)
        // Its phone previews end with it (W11.2: workspace removal invalidates sessions).
        await phonePreviews?.retireProject(path)
        sendJson(res, 200, { data: { project, pausedSchedules: scheduled.length } })
        return true
      }
      if (parts[1] === 'projects' && parts.length === 2) {
        if (method === 'GET') {
          projects.ensure(store.list().map((meta) => ({ path: meta.projectPath, at: meta.updatedAt })))
          sendJson(res, 200, { data: withIdentity(projects.list(), workspaces) })
          return true
        }
        if (method === 'POST') {
          const { path, ...patch } = parseBody(projectBody, await readJson(req))
          assertDirectory(path)
          sendJson(res, 200, { data: projects.open(path, patch) })
          return true
        }
      }
      if (parts[1] !== 'threads') throw new HttpError(404, 'Not found')

      // Every message of every conversation, for the list's search (before /api/threads/:id).
      if (parts.length === 3 && parts[2] === 'search' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        if (q.length > MAX_QUERY) throw new HttpError(400, 'Search for something shorter')
        sendJson(res, 200, { data: searchThreads(store, q, url.searchParams.get('projectPath') ?? undefined) })
        return true
      }

      if (parts.length === 2 && method === 'GET') {
        sendJson(res, 200, { data: manager.summaries() })
        return true
      }
      if (parts.length === 2 && method === 'POST') {
        const body = parseBody(createThreadBody, await readJson(req, IMAGE_BODY_BYTES))
        assertDirectory(body.projectPath)
        // A worktree to start in is checked like every workspace request; the project's primary is the default.
        const start = body.workspaceId ? scope.resolve(body.projectPath, body.workspaceId) : undefined
        // A12: an explicit title wins; otherwise a message opening with one workflow is named after it.
        const title = body.title?.trim() || workflowTitle(body.text, body.projectPath, workflows.store)
        const meta = manager.create({ ...body, ...(title ? { title } : {}), ...expandedFor(body.text, body.projectPath, start?.cwd), images: decodeImages(body.images) })
        projects.open(body.projectPath)
        sendJson(res, 201, { data: meta })
        return true
      }

      const threadId = parts[2] ?? ''
      if (!store.get(threadId)) throw new HttpError(404, 'Unknown thread')
      const action = parts[3]

      if (method === 'GET' && action === 'events') {
        sendJson(res, 200, {
          data: {
            meta: store.get(threadId),
            status: manager.status(threadId),
            events: store.events(threadId),
            transcriptPath: store.transcriptPath(threadId),
            streaming: manager.partialText(threadId),
          },
        })
      } else if (method === 'GET' && action === 'images' && parts.length === 5) {
        // Only names the store itself writes; served as exactly that image type and nothing else.
        const image = IMAGE_FILE.test(parts[4]!) ? images.read(threadId, parts[4]!) : undefined
        if (!image) throw new HttpError(404, 'No such image')
        res.writeHead(200, {
          'content-type': image.mediaType,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
          'cross-origin-resource-policy': 'same-origin',
        })
        res.end(image.bytes)
      } else if (method === 'POST' && action === 'messages') {
        const { text, images: attached, operationId, workspaceId } = parseBody(messageBody, await readJson(req, IMAGE_BODY_BYTES))
        // The folder the message works in: the workspace it names (checked), else the conversation's current one; a gone one is refused, never the primary.
        const thread = store.get(threadId)!
        const at = workspaceId ? scope.resolve(thread.projectPath, workspaceId) : undefined
        const folder = at?.cwd ?? (() => { const f = workspaceFolder(workspaces ? (id) => workspaces.get(id) : undefined, thread.projectPath, thread.workspaceId); if (isRefusal(f)) throw new HttpError(409, f.refusal); return f.cwd })()
        const expanded = expandedFor(text, thread.projectPath, folder)
        const { runId, replayed } = manager.send(threadId, text, expanded.agentText, expanded.workflows, undefined, decodeImages(attached, (file) => images.read(threadId, file)?.bytes), operationId, workspaceId)
        sendJson(res, 202, { data: { status: manager.status(threadId), runId, replayed } })
      } else if (method === 'POST' && action === 'approvals' && parts[4]) {
        manager.approve(threadId, parts[4], parseBody(approvalBody, await readJson(req)).behavior)
        sendJson(res, 200, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'queued' && parts[4] && parts[5] === 'remove') {
        sendJson(res, 200, { data: await manager.unqueue(threadId, parts[4]) })
      } else if (method === 'POST' && action === 'questions' && parts[4]) {
        manager.answerQuestion(threadId, parts[4], parseBody(questionBody, await readJson(req)).answers)
        sendJson(res, 200, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'interrupt') {
        await checks?.cancelForThread(threadId)
        manager.interrupt(threadId)
        sendJson(res, 202, { data: {} })
      } else if (method === 'DELETE' && !action) {
        if (viaPhone) throw new HttpError(403, 'Conversations can only be deleted on the Mac')
        // K2: a conversation that owns running processes is deleted only with an explicit choice for them.
        const { processes: choice } = parseBody(deleteThreadBody, await readJson(req))
        const owned = processes.ownedBy(threadId)
        if (owned.length && !choice) {
          throw new HttpError(409, `This conversation owns running processes (${owned.map((p) => p.name).join(', ')}). Choose Stop owned processes or Keep as project processes.`)
        }
        if (owned.length && choice) await processes.release(threadId, choice)
        await checks?.cancelForThread(threadId)
        await manager.remove(threadId)
        sendJson(res, 200, { data: { deleted: threadId } })
      } else if (method === 'POST' && action === 'completed') {
        sendJson(res, 200, { data: manager.setCompleted(threadId, parseBody(completedBody, await readJson(req)).completed) })
      } else if (method === 'POST' && action === 'dismiss') {
        await readJson(req)
        try { manager.dismissAwaiting(threadId) } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)) }
        sendJson(res, 200, { data: {} })
      } else if (method === 'POST' && action === 'settings') {
        const { settings } = parseBody(switchBody, await readJson(req))
        try { sendJson(res, 200, { data: manager.changeSettings(threadId, settings) }) } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)) }
      } else if (method === 'GET' && action === 'handoff') {
        sendJson(res, 200, { data: manager.handoffPreview(threadId) })
      } else if (method === 'POST' && action === 'agent') {
        const { settings, handoff } = parseBody(agentSwitchBody, await readJson(req))
        sendJson(res, 200, { data: manager.switchAgent(threadId, settings, handoff) })
      } else {
        throw new HttpError(404, 'Not found')
      }
      return true
    } catch (error: unknown) {
      const status = error instanceof HttpError ? error.status : error instanceof MemoryReadError || error instanceof StoreReadError || error instanceof ProcessConflictError || error instanceof ThreadBusyError || error instanceof OperationConflictError || error instanceof HandoffChangedError || error instanceof ChooseWorkspaceError || error instanceof WorkspaceUnavailableError ? 409 : error instanceof MessageReferenceError || error instanceof ImageAttachError ? 400 : 500
      const message = error instanceof Error ? error.message : 'Unexpected error'
      if (status === 500) console.error('[cockpit] request failed', error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      return true
    }
  }
}
