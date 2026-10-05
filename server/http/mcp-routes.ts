import { startConversationInput, sendConversationInput, stopConversationInput, type ConversationControl } from '../mcp/control.ts'
import { listConversations, listConversationsInput, readConversation, readConversationInput, type ConversationDeps } from '../mcp/conversations.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { McpSessions } from '../mcp/sessions.ts'
import type { ProcessRunner } from '../processes/runner.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import type { Workflow, WorkflowStore } from '../workflows/store.ts'
import { AgentWorkflowRefused, agentWorkflowSchema, checkAgentWorkflow, saveAgentWorkflow } from '../workflows/agent-input.ts'
import type { McpGrant } from '../mcp/sessions.ts'
import type { HostActionOptions } from '../threads/host-actions.ts'
import { readCursor } from './process-routes.ts'
import { oneLine } from '../files/visible-name.ts'
import { MAX_MEMORY_CHARS, memoryScope, recallText, type MemoryStore } from '../memory/store.ts'

// /api/mcp: the cockpit MCP server (one per agent session) calls back here.
// Every call carries that session's bearer token, and everything it can see or
// touch is confined to the session's own project.

const startBody = z.object({ command: z.string().trim().min(1).max(2000), name: z.string().trim().min(1).max(60).optional() })
const previewBody = z.object({ url: z.string().min(1).max(2000) })

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Only a local http(s) page can be previewed; the agent must not open arbitrary sites. */
export function assertLocalUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, `Not a URL: ${raw}`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK.has(url.hostname)) {
    throw new HttpError(400, `Preview only opens local http(s) pages (localhost, 127.0.0.1), not ${raw}`)
  }
  return url.toString()
}

export interface McpRouteDeps {
  readonly control?: ConversationControl
  readonly conversations?: ConversationDeps
  readonly workflows?: WorkflowStore
  readonly sessions: McpSessions
  readonly processes: ProcessRunner
  readonly openUrl: (url: string) => Promise<void> | void
  readonly capturePreview?: (url: string) => Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }>
  readonly memory?: MemoryStore
  /** Whether the project lets agents update and schedule workflows (Project settings). */
  readonly agentWorkflows?: (projectPath: string) => boolean
  /** Turns a workflow's schedule on, as the Workflows page does. */
  readonly enableWorkflow?: (id: string) => Workflow
  /**
   * Asks the user, in the calling conversation, to approve one action (the manager's host actions).
   * The agent's own CLI gate is not enough: its session token is in its environment, so its shell
   * can call these routes directly. Without this, the routes that change things refuse.
   */
  readonly approve?: (grant: McpGrant, toolName: string, input: Record<string, unknown>, options: HostActionOptions, signal: AbortSignal) => Promise<void>
}

const APPROVAL_SECONDS = 45

/** Runs `action` only after the user approves it; the approval is dropped if the agent hangs up. */
async function approved<T>(deps: McpRouteDeps, grant: McpGrant, res: ServerResponse, tool: string, input: Record<string, unknown>,
  options: Omit<HostActionOptions, 'timeoutMs' | 'label'> & { description: string }, action: () => T | Promise<T>): Promise<T> {
  if (!deps.approve) throw new HttpError(503, 'Cockpit cannot ask for approval here')
  const abort = new AbortController()
  const disconnected = (): void => { if (!res.writableEnded) abort.abort() }
  res.once('close', disconnected)
  try {
    await deps.approve(grant, `mcp__cockpit__${tool}`, input, { ...options, label: 'Cockpit action', timeoutMs: APPROVAL_SECONDS * 1000,
      description: `${options.description} Answer within ${APPROVAL_SECONDS} seconds.` }, abort.signal)
      .catch((error: Error) => { throw new HttpError(409, error.message) })
  } finally { res.removeListener('close', disconnected) }
  return action()
}

export async function handleMcpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: readonly string[],
  deps: McpRouteDeps,
): Promise<void> {
  const { sessions, processes, openUrl, capturePreview, workflows, memory, conversations, control, agentWorkflows, enableWorkflow } = deps
  const auth = req.headers.authorization ?? ''
  const grant = auth.startsWith('Bearer ') ? sessions.resolve(auth.slice('Bearer '.length)) : undefined
  if (!grant) throw new HttpError(401, 'Missing or expired cockpit session token')
  const method = req.method ?? 'GET'
  const { projectPath } = grant

  if (parts[2] === 'conversations') {
    if (!conversations) throw new HttpError(503, 'Conversation controls unavailable')
    const number = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined
    if (method === 'GET' && parts.length === 3) return sendJson(res, 200, { data: listConversations(conversations, grant,
      parseBody(listConversationsInput, { limit: number('limit'), cursor: url.searchParams.get('cursor') ?? undefined })) })
    if (method === 'GET' && parts.length === 4) return sendJson(res, 200, { data: readConversation(conversations, grant,
      parseBody(readConversationInput, { id: parts[3], since: number('since'), limit: number('limit') })) })
    if (method === 'POST' && parts.length === 4 && control && ['start', 'send', 'stop'].includes(parts[3]!)) {
      const body = await readJson(req)
      const request = parts[3] === 'start' ? { action: 'start' as const, input: parseBody(startConversationInput, body) }
        : parts[3] === 'send' ? { action: 'send' as const, input: parseBody(sendConversationInput, body) }
        : { action: 'stop' as const, input: parseBody(stopConversationInput, body) }
      const abort = new AbortController()
      const disconnected = () => { if (!res.writableEnded) abort.abort() }
      res.once('close', disconnected)
      try {
        const result = await control.execute(grant, request, () => sessions.resolve(auth.slice('Bearer '.length)) === grant, abort.signal)
        return sendJson(res, 200, { data: result })
      } finally { res.removeListener('close', disconnected) }
    }
    throw new HttpError(404, 'Not found')
  }
  if (parts[2] === 'workflows' && method === 'POST') {
    if (!workflows) throw new HttpError(503, 'Workflows unavailable')
    // Only the fields an agent may set: never another project, never a schedule unless allowed.
    const body = parseBody(agentWorkflowSchema, await readJson(req))
    const allowed = agentWorkflows?.(projectPath) === true
    try {
      // With the project's setting off, a new workflow (schedule off) is saved only after the user approves it.
      checkAgentWorkflow(workflows, projectPath, body, allowed)
      if (!allowed) {
        await approved(deps, grant, res, 'save_workflow', { name: body.name, ...(body.title ? { title: body.title } : {}), prompt: body.prompt },
          { description: `Save a new workflow "${oneLine(body.name)}" in this project, with its schedule off.` }, () => undefined)
      }
      const saved = saveAgentWorkflow(workflows, projectPath, body, {
        allowed,
        enable: (id) => {
          if (!enableWorkflow) throw new HttpError(503, 'Schedules unavailable')
          return enableWorkflow(id)
        },
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      return sendJson(res, saved.updated ? 200 : 201, { data: saved })
    } catch (error) {
      if (error instanceof AgentWorkflowRefused) throw new HttpError(error.status, error.message)
      throw error
    }
  }
  // Memory: recall searches this project's and the everywhere entries; remember (approved by the
  // user before the agent can call it) records which conversation it came from.
  if (parts[2] === 'memory') {
    if (!memory) throw new HttpError(503, 'Memory unavailable')
    if (method === 'GET') return sendJson(res, 200, { data: { text: recallText(memory.search(projectPath, (url.searchParams.get('q') ?? '').slice(0, 200))) } })
    if (method === 'POST') {
      const body = parseBody(z.object({ text: z.string().trim().min(1).max(MAX_MEMORY_CHARS), scope: memoryScope.default('project') }), await readJson(req))
      const where = body.scope === 'everywhere' ? 'for every project: agents in all your projects will read it' : 'for this project'
      const entry = await approved(deps, grant, res, 'remember', { text: body.text, scope: body.scope },
        { description: `Remember this ${where}.` }, () => memory.add({ ...body, projectPath, source: { kind: 'conversation', threadId: grant.threadId } }))
      return sendJson(res, 201, { data: entry })
    }
  }
  if (parts[2] === 'preview' && parts[3] === 'screenshot' && method === 'POST') {
    if (!capturePreview) throw new HttpError(503, 'Preview inspection is only available in the Cockpit desktop app')
    const target = assertLocalUrl(parseBody(previewBody, await readJson(req)).url)
    return sendJson(res, 200, { data: { inspected: target, ...(await capturePreview(target)) } })
  }
  if (parts[2] === 'preview' && parts.length === 3 && method === 'POST') {
    const target = assertLocalUrl(parseBody(previewBody, await readJson(req)).url)
    await openUrl(target)
    sendJson(res, 200, { data: { opened: target } })
    return
  }
  if (parts[2] !== 'processes') throw new HttpError(404, 'Not found')

  const id = parts[3]
  if (!id) {
    if (method === 'GET') return sendJson(res, 200, { data: processes.list(projectPath) })
    if (method === 'POST') {
      const body = parseBody(startBody, await readJson(req))
      const started = await approved(deps, grant, res, 'start_process', { command: body.command, ...(body.name ? { name: body.name } : {}) },
        { description: 'Run this command in the project, as a process Cockpit keeps running.', sessionKey: 'processes' },
        () => processes.start({ projectPath, ...body }))
      return sendJson(res, 201, { data: started })
    }
    throw new HttpError(404, 'Not found')
  }
  // A process from another project does not exist as far as this session is concerned.
  if (processes.get(id)?.projectPath !== projectPath) throw new HttpError(404, `No process ${id} in this project`)
  const action = parts[4]
  if (method === 'GET' && action === 'output') {
    const since = readCursor(url.searchParams.get('since'), Number.MAX_SAFE_INTEGER)
    const tail = readCursor(url.searchParams.get('tail'), 2000)
    return sendJson(res, 200, { data: processes.read(id, { ...(since !== undefined ? { since } : {}), tail: tail ?? 100 }) })
  }
  if (method === 'POST' && action === 'stop') {
    const info = processes.get(id)!
    const stopped = await approved(deps, grant, res, 'stop_process', { id, name: info.name, command: info.command },
      { description: `Stop ${oneLine(info.name)} and everything it started.`, sessionKey: 'processes' }, () => processes.stop(id))
    return sendJson(res, 200, { data: stopped })
  }
  throw new HttpError(404, 'Not found')
}
