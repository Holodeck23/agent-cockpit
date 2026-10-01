import { expandFiles, listFiles, readProjectFile } from '../files/browser.ts'
import { MessageReferenceError } from '../files/references.ts'
import { FileConflictError, writeProjectFile } from '../files/editor.ts'
import { checkReferences, searchFiles } from '../files/search.ts'
import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { ProcessRunner } from '../processes/runner.ts'
import { projectPatchSchema, type ProjectStore } from '../projects/store.ts'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { threadSettingsSchema } from '../threads/types.ts'
import { isTrustedRequest } from './guard.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { handleGitRoute } from './git-routes.ts'
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
})
const switchBody = z.object({ settings: threadSettingsSchema })
const projectBody = projectPatchSchema.extend({ path: z.string().min(1).max(1000) })

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
}

export function createApiHandler({ manager, store, projects, processes, mcp, workflows, remote, agents }: ApiDeps, allowedPorts: readonly number[]) {
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
      if (parts[1] === 'agents' && parts.length === 2 && method === 'GET' && agents) {
        sendJson(res, 200, { data: await agents() })
        return true
      }
      if (parts[1] === 'files' && parts[2] === 'write' && method === 'PUT') {
        if (viaPhone) throw new HttpError(403, 'Editing files is only available on the Mac')
        const body = parseBody(writeFileBody, await readJson(req))
        if (!projects.list().some((project) => project.path === body.projectPath)) throw new HttpError(404, 'Open this project first')
        try {
          sendJson(res, 200, { data: writeProjectFile(body.projectPath, body.path, body.text, body.expected) })
        } catch (error) {
          throw new HttpError(error instanceof FileConflictError ? 409 : 400, error instanceof Error ? error.message : String(error))
        }
        return true
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
          const data = parts[2] === 'read' ? readProjectFile(projectPath, path) : parts.length === 2 ? listFiles(projectPath, path) : undefined
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
      if (parts[1] === 'git') {
        await handleGitRoute(req, res, url, parts, { projects, manager }, viaPhone)
        return true
      }
      if (parts[1] === 'processes') {
        await handleProcessRoute(req, res, url, parts, processes)
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
      } else if (method === 'POST' && action === 'agent') {
        sendJson(res, 200, { data: manager.switchAgent(threadId, parseBody(switchBody, await readJson(req)).settings) })
      } else {
        throw new HttpError(404, 'Not found')
      }
      return true
    } catch (error: unknown) {
      const status = error instanceof HttpError ? error.status : error instanceof MessageReferenceError ? 400 : 500
      const message = error instanceof Error ? error.message : 'Unexpected error'
      if (status === 500) console.error('[cockpit] request failed', error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      return true
    }
  }
}
