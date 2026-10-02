import { listConversations, listConversationsInput, readConversation, readConversationInput, type ConversationDeps } from '../mcp/conversations.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { McpSessions } from '../mcp/sessions.ts'
import type { ProcessRunner } from '../processes/runner.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { workflowInputSchema, type WorkflowStore } from '../workflows/store.ts'
import { readCursor } from './process-routes.ts'
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
  readonly conversations?: ConversationDeps
  readonly workflows?: WorkflowStore
  readonly sessions: McpSessions
  readonly processes: ProcessRunner
  readonly openUrl: (url: string) => Promise<void> | void
  readonly capturePreview?: (url: string) => Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }>
  readonly memory?: MemoryStore
}

export async function handleMcpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: readonly string[],
  { sessions, processes, openUrl, capturePreview, workflows, memory, conversations }: McpRouteDeps,
): Promise<void> {
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
    throw new HttpError(404, 'Not found')
  }
  if (parts[2] === 'workflows' && method === 'POST') {
    if (!workflows) throw new HttpError(503, 'Workflows unavailable')
    const body = parseBody(workflowInputSchema.pick({ name: true, prompt: true }), await readJson(req))
    return sendJson(res, 201, { data: workflows.save({ ...body, projectPath }) })
  }
  // Memory: recall searches this project's and the everywhere entries; remember (approved by the
  // user before the agent can call it) records which conversation it came from.
  if (parts[2] === 'memory') {
    if (!memory) throw new HttpError(503, 'Memory unavailable')
    if (method === 'GET') return sendJson(res, 200, { data: { text: recallText(memory.search(projectPath, (url.searchParams.get('q') ?? '').slice(0, 200))) } })
    if (method === 'POST') {
      const body = parseBody(z.object({ text: z.string().trim().min(1).max(MAX_MEMORY_CHARS), scope: memoryScope.default('project') }), await readJson(req))
      return sendJson(res, 201, { data: memory.add({ ...body, projectPath, source: { kind: 'conversation', threadId: grant.threadId } }) })
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
      return sendJson(res, 201, { data: processes.start({ projectPath, ...body }) })
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
  if (method === 'POST' && action === 'stop') return sendJson(res, 200, { data: await processes.stop(id) })
  throw new HttpError(404, 'Not found')
}
