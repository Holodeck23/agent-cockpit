import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { WorkflowRunRefusedError, type WorkflowRunner } from '../workflows/runner.ts'
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
    if (!statSync(input.projectPath, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(400, 'Project folder is unavailable')
    // A name already taken, a schedule given twice, a workflow moved to another project: refusals the person can fix.
    try { return sendJson(res, id ? 200 : 201, { data: deps.store.save(input, id) }) } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)) }
  }
  if (!id || !deps.store.get(id)) throw new HttpError(404, 'Unknown workflow')
  if (req.method === 'POST' && parts[3] === 'run') {
    // A missing project folder is the person's to fix (the run has paused the schedule and kept the reason), like it is on save.
    try { return sendJson(res, 201, { data: deps.runner.run(id) }) } catch (error) {
      throw error instanceof WorkflowRunRefusedError ? new HttpError(400, error.message) : error
    }
  }
  if (req.method === 'POST' && parts[3] === 'enabled') {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), await readJson(req))
    // Refused without a schedule to enable.
    try { return sendJson(res, 200, { data: deps.runner.setEnabled(id, enabled) }) } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)) }
  }
  if (req.method === 'POST' && parts[3] === 'archive') {
    return sendJson(res, 200, { data: deps.store.update(id, { archived: true, enabled: false, nextRunAt: null, scheduleAuthorization: undefined }) })
  }
  throw new HttpError(404, 'Not found')
}
