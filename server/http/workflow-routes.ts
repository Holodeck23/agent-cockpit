import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { WorkflowRunner } from '../workflows/runner.ts'
import { workflowInputSchema, type WorkflowStore } from '../workflows/store.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

export interface WorkflowDeps { store: WorkflowStore; runner: WorkflowRunner }
export async function handleWorkflowRoute(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], deps: WorkflowDeps) {
  const id = parts[2]
  if (req.method === 'GET' && !id) {
    return sendJson(res, 200, { data: deps.store.list(url.searchParams.get('projectPath') ?? undefined) })
  }
  if (req.method === 'POST' && (!id || parts[3] === 'save')) {
    const input = parseBody(workflowInputSchema, await readJson(req))
    if (!statSync(input.projectPath).isDirectory()) throw new HttpError(400, 'Project folder is unavailable')
    return sendJson(res, id ? 200 : 201, { data: deps.store.save(input, id) })
  }
  if (!id || !deps.store.get(id)) throw new HttpError(404, 'Unknown workflow')
  if (req.method === 'POST' && parts[3] === 'run') return sendJson(res, 201, { data: deps.runner.run(id) })
  if (req.method === 'POST' && parts[3] === 'enabled') {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), await readJson(req))
    return sendJson(res, 200, { data: deps.runner.setEnabled(id, enabled) })
  }
  if (req.method === 'POST' && parts[3] === 'archive') {
    return sendJson(res, 200, { data: deps.store.update(id, { archived: true, enabled: false, nextRunAt: null }) })
  }
  throw new HttpError(404, 'Not found')
}
