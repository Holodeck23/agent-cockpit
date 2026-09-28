import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProcessRunner } from '../processes/runner.ts'
import { HttpError, sendJson } from './json.ts'

// /api/processes: what the page needs to show and stop running project
// processes. Agents start them through the cockpit MCP (./mcp-routes.ts).

export function readCursor(value: string | null, max: number): number | undefined {
  if (value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Expected a whole number, got ${value}`)
  return Math.min(n, max)
}

export async function handleProcessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: readonly string[],
  runner: ProcessRunner,
): Promise<void> {
  const method = req.method ?? 'GET'
  const id = parts[2]
  const action = parts[3]

  if (!id && method === 'GET') {
    sendJson(res, 200, { data: runner.list(url.searchParams.get('project') ?? undefined) })
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
  throw new HttpError(404, 'Not found')
}
