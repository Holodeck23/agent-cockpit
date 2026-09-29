import { expandFiles, listFiles, readProjectFile } from '../files/browser.ts'
import { MessageReferenceError } from '../files/references.ts'
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
import { handleMcpRoute, type McpRouteDeps } from './mcp-routes.ts'
import { handleProcessRoute } from './process-routes.ts'
import { handleWorkflowRoute, type WorkflowDeps } from './workflow-routes.ts'
import { expandWorkflows } from '../workflows/store.ts'
import { openSse } from './sse.ts'

const createThreadBody = z.object({
  projectPath: z.string().min(1).max(1000),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(200_000),
  settings: threadSettingsSchema.default(threadSettingsSchema.parse({})),
})
const messageBody = z.object({ text: z.string().min(1).max(200_000) })
const approvalBody = z.object({ behavior: z.enum(['allow', 'allow_session', 'deny']) })
const completedBody = z.object({ completed: z.boolean() })
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
}

export function createApiHandler({ manager, store, projects, processes, mcp, workflows }: ApiDeps, allowedPorts: readonly number[]) {
  // The agent gets attachments and workflow instructions inlined; the thread keeps what the user wrote.
  const agentTextFor = (text: string, projectPath: string): string =>
    expandFiles(expandWorkflows(text, projectPath, workflows.store), projectPath)

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api') return false
    const method = req.method ?? 'GET'

    if (!isTrustedRequest(req, allowedPorts)) {
      sendJson(res, 403, { error: 'Request did not come from the cockpit page' })
      return true
    }

    try {
      if (method === 'GET' && parts[1] === 'stream') {
        openSse(req, res, manager, processes)
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
      if (parts[1] === 'workflows') {
        await handleWorkflowRoute(req, res, url, parts, workflows)
        return true
      }
      if (parts[1] === 'mcp') {
        await handleMcpRoute(req, res, url, parts, mcp)
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
        const meta = manager.create({ ...body, agentText: agentTextFor(body.text, body.projectPath) })
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
        manager.send(threadId, text, agentTextFor(text, store.get(threadId)!.projectPath))
        sendJson(res, 202, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'approvals' && parts[4]) {
        manager.approve(threadId, parts[4], parseBody(approvalBody, await readJson(req)).behavior)
        sendJson(res, 200, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'interrupt') {
        manager.interrupt(threadId)
        sendJson(res, 202, { data: {} })
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
