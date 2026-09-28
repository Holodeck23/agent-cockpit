import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { threadSettingsSchema } from '../threads/types.ts'
import { isTrustedRequest } from './guard.ts'
import { openSse } from './sse.ts'

const MAX_BODY_BYTES = 1_000_000

const createThreadBody = z.object({
  projectPath: z.string().min(1).max(1000),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(200_000),
  settings: threadSettingsSchema.default(threadSettingsSchema.parse({})),
})
const messageBody = z.object({ text: z.string().min(1).max(200_000) })
const approvalBody = z.object({ behavior: z.enum(['allow', 'deny']) })
const completedBody = z.object({ completed: z.boolean() })

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Body is not valid JSON')
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error))
  return result.data
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function assertDirectory(path: string): void {
  try {
    if (statSync(path).isDirectory()) return
  } catch {
    // fall through
  }
  throw new HttpError(400, `Not a folder on this computer: ${path}`)
}

export function createApiHandler(manager: ThreadManager, store: ThreadStore, allowedPorts: readonly number[]) {
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
        openSse(req, res, manager)
        return true
      }
      if (parts[1] !== 'threads') throw new HttpError(404, 'Not found')

      if (parts.length === 2 && method === 'GET') {
        sendJson(res, 200, { data: manager.summaries() })
        return true
      }
      if (parts.length === 2 && method === 'POST') {
        const body = parseBody(createThreadBody, await readJson(req))
        assertDirectory(body.projectPath)
        const meta = manager.create(body)
        sendJson(res, 201, { data: meta })
        return true
      }

      const threadId = parts[2] ?? ''
      if (!store.get(threadId)) throw new HttpError(404, 'Unknown thread')
      const action = parts[3]

      if (method === 'GET' && action === 'events') {
        sendJson(res, 200, { data: { meta: store.get(threadId), status: manager.status(threadId), events: store.events(threadId) } })
      } else if (method === 'POST' && action === 'messages') {
        manager.send(threadId, parseBody(messageBody, await readJson(req)).text)
        sendJson(res, 202, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'approvals' && parts[4]) {
        manager.approve(threadId, parts[4], parseBody(approvalBody, await readJson(req)).behavior)
        sendJson(res, 200, { data: { status: manager.status(threadId) } })
      } else if (method === 'POST' && action === 'interrupt') {
        manager.interrupt(threadId)
        sendJson(res, 202, { data: {} })
      } else if (method === 'POST' && action === 'completed') {
        sendJson(res, 200, { data: manager.setCompleted(threadId, parseBody(completedBody, await readJson(req)).completed) })
      } else {
        throw new HttpError(404, 'Not found')
      }
      return true
    } catch (error: unknown) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : 'Unexpected error'
      if (status === 500) console.error('[cockpit] request failed', error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      return true
    }
  }
}
