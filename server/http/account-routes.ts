import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AGENT_IDS } from '../agents/capabilities/types.ts'
import { AccountBusyError, AccountInUseError, type AccountService } from '../agents/accounts/service.ts'
import { LABEL_MAX } from '../agents/accounts/store.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

// Account profiles (W12.1, INTERFACES): desktop only. The router refuses the phone before this
// runs; nothing here returns a folder path, an identity key or a credential, and none of it is an
// MCP tool. Every change is an explicit request from the Cockpit window.
//   GET  /api/accounts                          redacted list, support matrix (?refresh=1 rechecks the defaults)
//   POST /api/accounts                          { agent, label } → a sign-in in a new private context
//   GET  /api/accounts/signins/:id              the sign-in's state, link and output
//   POST /api/accounts/signins/:id/input        { text }: the code Claude's page shows
//   POST /api/accounts/signins/:id/cancel
//   POST /api/accounts/:id/refresh              re-read who is signed in
//   POST /api/accounts/:id/remove               { moveProjectsToDefault? } → result or refusal
//   GET  /api/projects/:id/accounts             the project's choice per agent
//   POST /api/projects/:id/accounts/:agent      { accountId } → revised choices

export const isAccountRoute = (parts: readonly string[]): boolean =>
  parts[1] === 'accounts' || (parts[1] === 'projects' && parts[3] === 'accounts')

const agentSchema = z.enum(AGENT_IDS)

export async function handleAccountRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], accounts: AccountService,
  projectPath: (projectId: string) => string | undefined,
): Promise<void> {
  const method = req.method ?? 'GET'
  try {
    if (parts[1] === 'projects') {
      const path = projectPath(parts[2] ?? '')
      if (!path) throw new HttpError(404, 'Unknown project')
      if (method === 'GET' && parts.length === 4) { sendJson(res, 200, { data: { selection: accounts.forProject(path) } }); return }
      if (method === 'POST' && parts.length === 5) {
        const agent = agentSchema.safeParse(parts[4])
        if (!agent.success) throw new HttpError(404, 'Unknown agent')
        const { accountId } = parseBody(z.object({ accountId: z.string().min(1).max(64) }), await readJson(req))
        sendJson(res, 200, { data: { selection: await accounts.select(path, agent.data, accountId) } })
        return
      }
      throw new HttpError(404, 'Not found')
    }
    if (parts.length === 2 && method === 'GET') {
      if (url.searchParams.get('refresh') === '1') await accounts.refreshDefaults()
      sendJson(res, 200, { data: { accounts: accounts.list(), support: accounts.support } })
      return
    }
    if (parts.length === 2 && method === 'POST') {
      const body = parseBody(z.object({ agent: agentSchema, label: z.string().trim().min(1).max(LABEL_MAX) }), await readJson(req))
      sendJson(res, 202, { data: await accounts.startSignin(body.agent, body.label) })
      return
    }
    if (parts[2] === 'signins') {
      const id = parts[3] ?? ''
      if (!accounts.signin(id)) throw new HttpError(404, 'Unknown sign-in')
      if (method === 'GET' && parts.length === 4) { sendJson(res, 200, { data: accounts.signin(id) }); return }
      if (method === 'POST' && parts[4] === 'input' && parts.length === 5) {
        // Passed to the waiting CLI only: never logged, stored or echoed.
        const { text } = parseBody(z.object({ text: z.string().trim().min(1).max(4000) }), await readJson(req))
        if (!accounts.signinInput(id, text)) throw new HttpError(409, 'This sign-in is not waiting for a code')
        sendJson(res, 200, { data: accounts.signin(id) })
        return
      }
      if (method === 'POST' && parts[4] === 'cancel' && parts.length === 5) {
        sendJson(res, 200, { data: { cancelled: accounts.cancelSignin(id), signin: accounts.signin(id) } })
        return
      }
      throw new HttpError(404, 'Not found')
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'refresh') {
      sendJson(res, 200, { data: await accounts.refresh(parts[2] ?? '') })
      return
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'remove') {
      const body = parseBody(z.object({ moveProjectsToDefault: z.boolean().optional() }), await readJson(req))
      sendJson(res, 200, { data: await accounts.remove(parts[2] ?? '', body) })
      return
    }
    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error instanceof AccountInUseError) {
      sendJson(res, 409, { error: error.message, ...(error.projects.length ? { projects: error.projects } : {}) })
      return
    }
    if (error instanceof AccountBusyError) throw new HttpError(409, error.message)
    throw new HttpError(422, error instanceof Error ? error.message : String(error))
  }
}
