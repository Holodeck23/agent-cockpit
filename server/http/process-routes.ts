import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProcessRunner } from '../processes/runner.ts'
import { HttpError, sendJson } from './json.ts'
import type { WorkspaceScope } from './workspace-scope.ts'

// /api/processes: what the page needs to show and stop running project
// processes. Agents start them through the cockpit MCP (./mcp-routes.ts).

export function readCursor(value: string | null, max: number): number | undefined {
  if (value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Expected a whole number, got ${value}`)
  return Math.min(n, max)
}

const requireScope = (scope: WorkspaceScope | undefined): WorkspaceScope => {
  if (!scope) throw new HttpError(409, 'Workspaces are unavailable')
  return scope
}

export async function handleProcessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: readonly string[],
  runner: ProcessRunner,
  scope?: WorkspaceScope,
): Promise<void> {
  const method = req.method ?? 'GET'
  const id = parts[2]
  const action = parts[3]

  if (!id && method === 'GET') {
    // `workspaceId` narrows to one workspace's processes (checked); `project` alone lists the whole project as before.
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined
    if (workspaceId) {
      const at = requireScope(scope).resolve(url.searchParams.get('project') ?? undefined, workspaceId)
      sendJson(res, 200, { data: runner.list(at.projectPath, at.cwd) })
      return
    }
    sendJson(res, 200, { data: runner.list(url.searchParams.get('project') ?? undefined) })
    return
  }
  // Show finished → Clear: the finished rows of one folder leave the history; nothing is stopped.
  if (id === 'clear-finished' && method === 'POST') {
    const project = url.searchParams.get('project') ?? ''
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined
    if (workspaceId) {
      const at = requireScope(scope).resolve(project || undefined, workspaceId)
      sendJson(res, 200, { data: { cleared: runner.clearFinished(at.projectPath, at.cwd) } })
      return
    }
    if (!project) throw new HttpError(400, 'Which project?')
    sendJson(res, 200, { data: { cleared: runner.clearFinished(project) } })
    return
  }
  if (!id || !runner.get(id)) throw new HttpError(404, 'Unknown process')
  if (method === 'GET' && action === 'output') {
    const since = readCursor(url.searchParams.get('since'), Number.MAX_SAFE_INTEGER)
    const tail = readCursor(url.searchParams.get('tail'), 2000)
    sendJson(res, 200, { data: runner.read(id, { ...(since !== undefined ? { since } : {}), tail: tail ?? 200 }) })
    return
  }
  if (method === 'POST' && action === 'stop') {
    sendJson(res, 200, { data: await runner.stop(id) })
    return
  }
  if (method === 'POST' && action === 'restart') {
    sendJson(res, 200, { data: await runner.restart(id) })
    return
  }
  throw new HttpError(404, 'Not found')
}
