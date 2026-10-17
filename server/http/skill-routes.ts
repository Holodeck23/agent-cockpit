// A project's own Claude skills, commands and agents (W13 U6). The source is host-computed from an
// account, never a path from the request; responses carry names and counts, never paths or content.
//   GET  /api/projects/:projectId/skills          current choice and what the CLI default profile offers
//   POST /api/projects/:projectId/skills          { sourceAccountId, replacing? } → chooses its current revision
//   POST /api/projects/:projectId/skills/revoke   { selectionId } → stops loading them
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { snapshotSkillSource } from '../agents/setup/skill-projection.ts'
import type { SkillSelection, SkillSelectionStore } from '../agents/setup/skill-selection.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

export interface SkillRouteDeps {
  readonly selections: SkillSelectionStore
  readonly destination: (projectPath: string) => { readonly accountId: string; readonly generation: number }
  /** The CLI default profile: the user's own setup. */
  readonly defaultProfileDir: string
}

export const isSkillRoute = (parts: readonly string[]): boolean => parts[1] === 'projects' && parts[3] === 'skills'

const viewOf = (row: SkillSelection) => ({ id: row.id, sourceAccountId: row.sourceAccountId, destinationAccountId: row.destinationAccountId,
  counts: row.counts, selectedAt: row.selectedAt })

export async function handleSkillRoute(
  req: IncomingMessage, res: ServerResponse, parts: readonly string[], deps: SkillRouteDeps,
  projectPath: (projectId: string) => string | undefined,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = projectPath(parts[2] ?? '')
  if (!path) throw new HttpError(404, 'Unknown project')
  if (method === 'GET' && parts.length === 4) {
    const current = deps.selections.get(path)
    let offered: ReturnType<typeof snapshotSkillSource> | undefined
    let problem: string | undefined
    try { offered = snapshotSkillSource(deps.defaultProfileDir) } catch (error) { problem = error instanceof Error ? error.message : 'Could not read your skills' }
    sendJson(res, 200, { data: {
      selection: current ? { ...viewOf(current), current: offered?.revision === current.revision } : null,
      offered: offered ? { sourceAccountId: 'default-claude', skills: offered.skills, commands: offered.commands, agents: offered.agents,
        excluded: offered.excluded.map((row) => ({ path: row.path, reason: row.reason })) } : null,
      ...(problem ? { problem } : {}),
    } })
    return
  }
  if (method === 'POST' && parts.length === 4) {
    const body = parseBody(z.object({ sourceAccountId: z.literal('default-claude'), replacing: z.uuid().optional() }), await readJson(req))
    const destination = deps.destination(path)
    try {
      const selected = deps.selections.select({ projectPath: path, destinationAccountId: destination.accountId, destinationGeneration: destination.generation,
        sourceAccountId: body.sourceAccountId, sourceProfileDir: deps.defaultProfileDir }, body.replacing)
      sendJson(res, 200, { data: { selection: viewOf(selected) } })
    } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Could not choose your skills') }
    return
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'revoke') {
    const { selectionId } = parseBody(z.object({ selectionId: z.uuid() }), await readJson(req))
    try { sendJson(res, 200, { data: { revoked: deps.selections.revoke(path, selectionId) } }) }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Could not stop loading your skills') }
    return
  }
  throw new HttpError(404, 'Not found')
}
