import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { CheckConflictError, checkDefinitionSchema, type CheckRunner } from '../results/checks.ts'
import { UnknownRunError, type ResultService } from '../results/service.ts'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { isBusy } from '../threads/status.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { assertLocalUrl } from './mcp-routes.ts'

// /api/runs and /api/checks: a run's result card (W7.4). Reading it, starting an approved check,
// capturing a preview and saying whether it looks right. An agent has no route to it (its MCP
// grant is separate). A paired phone may read the selected conversation's result and permitted
// evidence; every mutation remains on the Mac. Starting a check in this window is the person's
// approval of exactly that command.

const RUN_ID = /^[A-Za-z0-9-]{1,80}$/
const threadBody = z.object({ threadId: z.string().min(1).max(80) })
const checkBody = threadBody.extend({ operationId: z.string().min(8).max(80), definition: checkDefinitionSchema })
const previewBody = threadBody.extend({ url: z.string().min(1).max(2000) })
const assessBody = threadBody.extend({ evidenceId: z.string().min(1).max(100), verdict: z.enum(['looks-right', 'looks-wrong']), note: z.string().max(500).optional() })

export interface ResultRouteDeps {
  readonly manager: ThreadManager
  readonly store: ThreadStore
  readonly results: ResultService
  readonly checks: CheckRunner
  readonly isOpen: (projectPath: string) => boolean
}

export async function handleResultRoute(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], deps: ResultRouteDeps, viaPhone: boolean): Promise<void> {
  const method = req.method ?? 'GET'
  if (viaPhone && method !== 'GET') throw new HttpError(403, 'Result checks and assessments are only available on the Mac')
  const conversation = (threadId: string) => {
    const summary = deps.manager.summaries().find((s) => s.meta.id === threadId)
    if (!summary) throw new HttpError(404, 'Unknown conversation')
    if (!deps.isOpen(summary.meta.projectPath)) throw new HttpError(404, 'Open this project first')
    return summary
  }
  try {
    if (parts[1] === 'checks') {
      if (method === 'POST' && parts[3] === 'cancel' && parts[2]) {
        const cancelled = await deps.checks.cancel(parts[2])
        if (!cancelled) throw new HttpError(404, 'Unknown check')
        sendJson(res, 200, { data: cancelled })
        return
      }
      throw new HttpError(404, 'Not found')
    }
    const runId = parts[2] ?? ''
    if (!RUN_ID.test(runId)) throw new HttpError(400, 'Not a run ID')
    const action = parts[3]
    if (method === 'GET' && action === 'result') {
      const { meta, status } = conversation(url.searchParams.get('threadId') ?? '')
      sendJson(res, 200, { data: await deps.results.view(meta, deps.store.events(meta.id), runId, isBusy(status)) })
      return
    }
    if (method === 'GET' && action === 'evidence' && parts[4]) {
      const { meta } = conversation(url.searchParams.get('threadId') ?? '')
      const { record, read } = deps.results.evidence(meta, runId, parts[4])
      if (read.state !== 'ok') throw new HttpError(410, `This evidence is ${read.state}; it was not replaced.`)
      res.writeHead(200, { 'content-type': record.mediaType === 'image/png' ? 'image/png' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(read.bytes)
      return
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found')
    if (action === 'checks') {
      const body = parseBody(checkBody, await readJson(req))
      const { meta, status } = conversation(body.threadId)
      // The run must be this conversation's, and finished: a check describes a result.
      const view = await deps.results.view(meta, deps.store.events(meta.id), runId, isBusy(status))
      if (view.provider.state === 'working') throw new HttpError(409, 'Wait until this run has ended')
      const record = await deps.checks.start({ runId, threadId: meta.id, projectPath: meta.projectPath, ...(view.identity.workspaceId ? { workspaceId: view.identity.workspaceId } : {}), operationId: body.operationId, definition: body.definition })
      sendJson(res, 202, { data: record })
      return
    }
    if (action === 'preview') {
      const body = parseBody(previewBody, await readJson(req))
      const { meta, status } = conversation(body.threadId)
      await deps.results.view(meta, deps.store.events(meta.id), runId, isBusy(status))
      sendJson(res, 200, { data: await deps.results.capture(meta, runId, assertLocalUrl(body.url)) })
      return
    }
    if (action === 'assessments') {
      const body = parseBody(assessBody, await readJson(req))
      const { meta } = conversation(body.threadId)
      sendJson(res, 200, { data: deps.results.assess(meta, runId, body.evidenceId, body.verdict, body.note) })
      return
    }
    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof UnknownRunError) throw new HttpError(404, error.message)
    if (error instanceof CheckConflictError) throw new HttpError(409, error.message)
    throw error
  }
}
