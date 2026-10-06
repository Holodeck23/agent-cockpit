import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AGENT_IDS } from '../agents/capabilities/types.ts'
import { OperationBusyError, type Lifecycle, type OperationKind } from '../agents/lifecycle/service.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

// Install, update and sign-in for agent CLIs (W10.2/W10.3). Desktop only: the router refuses the
// phone before this runs, and none of it is an MCP tool. Every mutation is an explicit request.

const ACTIONS = new Set<OperationKind>(['install', 'update', 'signin'])

export function isAgentLifecycleRoute(parts: readonly string[]): boolean {
  return parts[1] === 'agent-operations' || (parts[1] === 'agents' && ['lifecycle', 'install', 'update', 'signin', 'updates'].includes(parts[3] ?? ''))
}

export async function handleAgentLifecycleRoute(req: IncomingMessage, res: ServerResponse, parts: readonly string[], lifecycle: Lifecycle): Promise<void> {
  const method = req.method ?? 'GET'
  if (parts[1] === 'agent-operations') {
    const id = parts[2] ?? ''
    if (!lifecycle.get(id)) throw new HttpError(404, 'Unknown operation')
    const action = parts[3]
    if (method === 'GET' && !action) { sendJson(res, 200, { data: lifecycle.get(id) }); return }
    if (method === 'POST' && action === 'cancel') { sendJson(res, 200, { data: { cancelled: lifecycle.cancel(id), operation: lifecycle.get(id) } }); return }
    if (method === 'POST' && action === 'resume') { sendJson(res, 200, { data: { resumed: lifecycle.resume(id), operation: lifecycle.get(id) } }); return }
    if (method === 'POST' && action === 'input') {
      // A pasted sign-in code: passed to the waiting helper only; never logged or stored.
      const { text } = parseBody(z.object({ text: z.string().min(1).max(4000) }), await readJson(req))
      lifecycle.write(id, text.endsWith('\n') ? text : `${text}\n`)
      sendJson(res, 200, { data: {} })
      return
    }
    throw new HttpError(404, 'Not found')
  }
  const agent = AGENT_IDS.find((a) => a === parts[2])
  if (!agent) throw new HttpError(404, 'Unknown agent')
  const action = parts[3]
  if (method === 'GET' && action === 'lifecycle' && parts.length === 4) {
    const [install, update, signin] = await Promise.all([lifecycle.plan(agent, 'install'), lifecycle.plan(agent, 'update'), lifecycle.plan(agent, 'signin')])
    const skipped = lifecycle.skipped(agent)
    sendJson(res, 200, { data: { install, update, signin, latest: lifecycle.lastCheck(agent), ...(skipped ? { skipped } : {}),
      operations: lifecycle.list().filter((op) => op.agent === agent).slice(-5) } })
    return
  }
  if (method === 'POST' && action === 'updates' && parts[4] === 'check' && parts.length === 5) {
    sendJson(res, 200, { data: await lifecycle.checkForUpdate(agent) })
    return
  }
  if (method === 'POST' && action === 'updates' && parts[4] === 'skip' && parts.length === 5) {
    const { version } = parseBody(z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }), await readJson(req))
    lifecycle.skip(agent, version)
    sendJson(res, 200, { data: { skipped: version } })
    return
  }
  if (method === 'POST' && ACTIONS.has(action as OperationKind) && parts.length === 4) {
    try {
      const body = action === 'install' ? parseBody(z.object({ acceptInstaller: z.string().regex(/^[a-f0-9]{64}$/).optional() }), await readJson(req)) : {}
      sendJson(res, 202, { data: await lifecycle.start(agent, action as OperationKind, body.acceptInstaller ? { acceptInstaller: body.acceptInstaller } : {}) })
    } catch (error) {
      if (error instanceof OperationBusyError) throw new HttpError(409, error.message)
      throw new HttpError(422, error instanceof Error ? error.message : String(error))
    }
    return
  }
  throw new HttpError(404, 'Not found')
}
