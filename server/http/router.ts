import { createRecovery, resumeRecoveryBody } from '../onboarding/recovery.ts'
import { automaticAgent, directorDismissed, dismissDirector, ORIENTATION_PROMPT, prepareSample } from '../onboarding/director.ts'
import { expandFiles, listFiles, readProjectFile } from '../files/browser.ts'
import { MessageReferenceError } from '../files/references.ts'
import { FileConflictError, writeProjectFile } from '../files/editor.ts'
import { checkReferences, searchFiles } from '../files/search.ts'
import { listDocuments, markDocument, renameFile, spaceRoot, spaceSchema } from '../files/documents.ts'
import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { ProcessRunner } from '../processes/runner.ts'
import { projectPatchSchema, type ProjectStore } from '../projects/store.ts'
import { ImageError, readProjectImage, removeProjectImages, saveProjectImage } from '../projects/images.ts'
import { MAX_MEMORY_CHARS, MemoryReadError, memoryScope, type MemoryStore } from '../memory/store.ts'
import { listSessions } from '../import/sessions.ts'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { threadSettingsSchema } from '../threads/types.ts'
import { MAX_QUERY, searchThreads } from '../threads/search.ts'
import { isTrustedRequest } from './guard.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { handleGitRoute } from './git-routes.ts'
import type { PresetStore } from '../presets/store.ts'
import { handleMcpRoute, type McpRouteDeps } from './mcp-routes.ts'
import { handleProcessRoute } from './process-routes.ts'
import { handleWorkflowRoute, type WorkflowDeps } from './workflow-routes.ts'
import { resolveWorkflows } from '../workflows/store.ts'
import type { WorkflowSnapshot } from '../agents/types.ts'
import { openSse } from './sse.ts'
import type { RemoteAccess } from '../remote/service.ts'
import type { AgentStatus } from '../agents/status.ts'

const createThreadBody = z.object({
  projectPath: z.string().min(1).max(1000),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(200_000),
  settings: threadSettingsSchema.default(threadSettingsSchema.parse({})),
})
const messageBody = z.object({ text: z.string().min(1).max(200_000) })
const approvalBody = z.object({ behavior: z.enum(['allow', 'allow_session', 'deny']) })
const completedBody = z.object({ completed: z.boolean() })
const checkReferencesBody = z.object({ projectPath: z.string().min(1).max(1000), text: z.string().max(200_000) })
const writeFileBody = z.object({
  projectPath: z.string().min(1).max(1000),
  path: z.string().min(1).max(1000),
  text: z.string().max(200_000),
  /** The version the edit started from; null creates a new file. */
  expected: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** The repository, or the app's own documents folder for the project. */
  space: spaceSchema,
})
const renameBody = z.object({ projectPath: z.string().min(1).max(1000), path: z.string().min(1).max(1000), name: z.string().min(1).max(255), space: spaceSchema })
const markBody = z.object({ projectPath: z.string().min(1).max(1000), path: z.string().min(1).max(255), pinned: z.boolean().optional(), archived: z.boolean().optional() })
const switchBody = z.object({ settings: threadSettingsSchema })
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
  readonly processes: ProcessRunner
  readonly mcp: McpRouteDeps
  readonly remote: RemoteAccess
  /** Installation and last reported usage per agent, for the agent picker. */
  readonly agents?: () => Promise<AgentStatus[]>
  readonly memory?: MemoryStore
  /** Named agent settings for the picker. */
  readonly presets?: PresetStore
  /** Where the CLIs keep their sessions (~), for Import conversations; tests point it elsewhere. */
  readonly importHome?: string
}

export function createApiHandler({ manager, store, projects, processes, mcp, workflows, remote, agents, memory, presets, importHome = homedir() }: ApiDeps, allowedPorts: readonly number[]) {
  const recovery = createRecovery({ store, manager, importHome, agents: agents ?? (async () => []) })
  // The agent gets attachments and workflow instructions inlined; the thread keeps what the user wrote.
  // The workflows used are kept with the message, as they were at send time.
  const expandedFor = (text: string, projectPath: string): { agentText: string; workflows?: WorkflowSnapshot[] } => {
    const resolved = resolveWorkflows(text, projectPath, workflows.store)
    return { agentText: expandFiles(resolved.text, projectPath), ...(resolved.used.length ? { workflows: resolved.used } : {}) }
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
      if (parts[1] === 'files' && parts[2] === 'write' && method === 'PUT') {
        if (viaPhone) throw new HttpError(403, 'Editing files is only available on the Mac')
        const body = parseBody(writeFileBody, await readJson(req))
        if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
        try {
          sendJson(res, 200, { data: writeProjectFile(spaceRoot(store.root, body.projectPath, body.space), body.path, body.text, body.expected) })
        } catch (error) {
          throw new HttpError(error instanceof FileConflictError ? 409 : 400, error instanceof Error ? error.message : String(error))
        }
        return true
      }
      if (parts[1] === 'files' && parts[2] === 'rename' && method === 'POST') {
        if (viaPhone) throw new HttpError(403, 'Renaming files is only available on the Mac')
        const body = parseBody(renameBody, await readJson(req))
        if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
        try { sendJson(res, 200, { data: { path: renameFile(store.root, body.projectPath, body.space, body.path, body.name) } }) }
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
        if (method === 'POST' && parts[2] === 'mark') {
          const body = parseBody(markBody, await readJson(req))
          if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
          try { markDocument(store.root, body.projectPath, body.path, body) } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
          sendJson(res, 200, { data: listDocuments(store.root, body.projectPath) })
          return true
        }
      }
      if (parts[1] === 'files' && parts[2] === 'search' && method === 'GET') {
        const projectPath = url.searchParams.get('projectPath') ?? ''
        if (!projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
        try { sendJson(res, 200, { data: searchFiles(projectPath, (url.searchParams.get('q') ?? '').slice(0, 200)) }) }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
        return true
      }
      if (parts[1] === 'references' && parts[2] === 'check' && method === 'POST') {
        const body = parseBody(checkReferencesBody, await readJson(req))
        if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
        sendJson(res, 200, { data: checkReferences(body.text, body.projectPath, workflows.store) })
        return true
      }
      if (parts[1] === 'files' && method === 'GET') {
        const projectPath = url.searchParams.get('projectPath') ?? ''
        if (!projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
        const path = url.searchParams.get('path') ?? ''
        try {
          const space = spaceSchema.parse(url.searchParams.get('space') ?? undefined)
          if (space === 'documents' && viaPhone) throw new Error('Your documents are only available on the Mac')
          const base = spaceRoot(store.root, projectPath, space)
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
        await handleGitRoute(req, res, url, parts, { projects, manager }, viaPhone)
        return true
      }
      if (parts[1] === 'processes') {
        await handleProcessRoute(req, res, url, parts, processes)
        return true
      }
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'image') {
        if (method === 'GET') {
          const project = projects.list().find((p) => p.path === url.searchParams.get('path'))
          const image = project?.image ? readProjectImage(store.root, project.image) : undefined
          if (!image) throw new HttpError(404, 'No picture')
          res.writeHead(200, { 'content-type': image.mime, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
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
      // Remove from Cockpit: the folder and its conversations stay; schedules there are paused.
      if (parts[1] === 'projects' && parts.length === 3 && parts[2] === 'remove' && method === 'POST') {
        const { path } = parseBody(z.object({ path: z.string().min(1).max(1000) }), await readJson(req))
        if (!projects.list().some((p) => p.path === path)) throw new HttpError(404, 'Unknown project')
        const busy = manager.summaries().filter((t) => t.meta.projectPath === path && (t.status === 'working' || t.status === 'needs_input')).length
        if (busy > 0) throw new HttpError(409, `${busy === 1 ? 'A conversation' : `${busy} conversations`} in this project ${busy === 1 ? 'is' : 'are'} still working or waiting for you. Stop or answer ${busy === 1 ? 'it' : 'them'} first.`)
        const scheduled = workflows.store.list(path).filter((w) => w.enabled)
        for (const w of scheduled) workflows.store.update(w.id, { enabled: false, nextRunAt: null })
        sendJson(res, 200, { data: { project: projects.hide(path), pausedSchedules: scheduled.length } })
        return true
      }
      if (parts[1] === 'projects' && parts.length === 2) {
        if (method === 'GET') {
          projects.ensure(store.list().map((meta) => ({ path: meta.projectPath, at: meta.updatedAt })))
          sendJson(res, 200, { data: projects.list() })
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
        const body = parseBody(createThreadBody, await readJson(req))
        assertDirectory(body.projectPath)
        const meta = manager.create({ ...body, ...expandedFor(body.text, body.projectPath) })
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
      } else if (method === 'POST' && action === 'messages') {
        const { text } = parseBody(messageBody, await readJson(req))
        const expanded = expandedFor(text, store.get(threadId)!.projectPath)
        manager.send(threadId, text, expanded.agentText, expanded.workflows)
        sendJson(res, 202, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'approvals' && parts[4]) {
        manager.approve(threadId, parts[4], parseBody(approvalBody, await readJson(req)).behavior)
        sendJson(res, 200, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'interrupt') {
        manager.interrupt(threadId)
        sendJson(res, 202, { data: {} })
      } else if (method === 'DELETE' && !action) {
        if (viaPhone) throw new HttpError(403, 'Conversations can only be deleted on the Mac')
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
      } else if (method === 'POST' && action === 'agent') {
        sendJson(res, 200, { data: manager.switchAgent(threadId, parseBody(switchBody, await readJson(req)).settings) })
      } else {
        throw new HttpError(404, 'Not found')
      }
      return true
    } catch (error: unknown) {
      const status = error instanceof HttpError ? error.status : error instanceof MemoryReadError ? 409 : error instanceof MessageReferenceError ? 400 : 500
      const message = error instanceof Error ? error.message : 'Unexpected error'
      if (status === 500) console.error('[cockpit] request failed', error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      return true
    }
  }
}
