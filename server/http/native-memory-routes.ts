// Project native memory selection (W13 U5): which Claude memory a project's conversations load.
// Sources are host-computed from an account, never a path from the request, and nothing here returns
// a path, a revision or memory content.
//   GET  /api/projects/:projectId/native-memory           current selection and the sources on offer
//   POST /api/projects/:projectId/native-memory           { sourceAccountId, replacing? } → selects
//   POST /api/projects/:projectId/native-memory/revoke    { selectionId } → stops loading it
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import { claudeProjectSlug } from '../agents/setup/claude-inventory.ts'
import type { NativeMemorySelection, NativeMemorySelectionStore } from '../agents/setup/native-memory-selection.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

export interface NativeMemoryRouteDeps {
  readonly selections: NativeMemorySelectionStore
  /** The account the project's Claude conversations run on, with its profile folder when managed. */
  readonly destination: (projectPath: string) => { readonly accountId: string; readonly generation: number; readonly profileDir?: string }
  /** The CLI default profile: the user's own setup. */
  readonly defaultProfileDir: string
  readonly label: (accountId: string) => string | undefined
}

export const isNativeMemoryRoute = (parts: readonly string[]): boolean => parts[1] === 'projects' && parts[3] === 'native-memory'

const DEFAULT_CLAUDE = 'default-claude'

interface Source { readonly accountId: string; readonly root: string; readonly dir: string }

function sourcesFor(deps: NativeMemoryRouteDeps, projectPath: string): Source[] {
  const at = (accountId: string, root: string): Source => ({ accountId, root, dir: join(root, 'projects', claudeProjectSlug(projectPath), 'memory') })
  const destination = deps.destination(projectPath)
  return [at(DEFAULT_CLAUDE, deps.defaultProfileDir),
    ...(destination.accountId !== DEFAULT_CLAUDE && destination.profileDir ? [at(destination.accountId, destination.profileDir)] : [])]
}

const viewOf = (deps: NativeMemoryRouteDeps, row: NativeMemorySelection) => ({
  id: row.id, sourceAccountId: row.sourceAccountId, sourceLabel: deps.label(row.sourceAccountId) ?? 'Removed account',
  destinationAccountId: row.destinationAccountId, writePolicy: row.writePolicy, fileCount: row.fileCount, selectedAt: row.selectedAt,
})

export async function handleNativeMemoryRoute(
  req: IncomingMessage, res: ServerResponse, parts: readonly string[], deps: NativeMemoryRouteDeps,
  projectPath: (projectId: string) => string | undefined,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = projectPath(parts[2] ?? '')
  if (!path) throw new HttpError(404, 'Unknown project')
  const scope = { projectPath: path }
  if (method === 'GET' && parts.length === 4) {
    const current = deps.selections.get(scope)
    sendJson(res, 200, { data: {
      selection: current ? viewOf(deps, current) : null,
      sources: sourcesFor(deps, path).map((source) => ({ accountId: source.accountId,
        label: deps.label(source.accountId) ?? source.accountId, available: existsSync(join(source.dir, 'MEMORY.md')) })),
    } })
    return
  }
  if (method === 'POST' && parts.length === 4) {
    const body = parseBody(z.object({ sourceAccountId: z.string().min(1).max(64), replacing: z.uuid().optional() }), await readJson(req))
    const source = sourcesFor(deps, path).find((row) => row.accountId === body.sourceAccountId)
    if (!source) throw new HttpError(400, 'Memory can come from your CLI default profile or this project’s Claude account only')
    const destination = deps.destination(path)
    try {
      const selected = deps.selections.select({ scope, destinationAccountId: destination.accountId, destinationGeneration: destination.generation,
        sourceAccountId: source.accountId, sourceRoot: source.root, sourceDir: source.dir,
        // Another account's memory is shared for reading; only an account's own memory is kept up to date automatically.
        writePolicy: source.accountId === destination.accountId ? 'managed-auto' : 'review' }, body.replacing)
      sendJson(res, 200, { data: { selection: viewOf(deps, selected) } })
    } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Could not select that memory') }
    return
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'revoke') {
    const { selectionId } = parseBody(z.object({ selectionId: z.uuid() }), await readJson(req))
    try { sendJson(res, 200, { data: { revoked: deps.selections.revoke(scope, selectionId) } }) }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Could not revoke that memory') }
    return
  }
  throw new HttpError(404, 'Not found')
}
