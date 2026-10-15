import { isAbsolute } from 'node:path'

/** An authenticated host round trip before the stdio bridge advertises tools. */
export async function verifyCockpitHost(baseUrl: string, token: string): Promise<void> {
  let url: URL
  try {
    url = new URL('/api/mcp/identity', baseUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error()
  } catch { throw new Error('Cockpit MCP host URL is not a local HTTP endpoint') }
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Cockpit MCP host authentication failed (${response.status})`)
  const payload: unknown = await response.json()
  const data = (payload as { data?: Record<string, unknown> } | null)?.data
  if (!data || data.server !== 'cockpit' || data.protocol !== 1 || typeof data.threadId !== 'string' || !data.threadId
    || typeof data.projectPath !== 'string' || !isAbsolute(data.projectPath)
    || typeof data.cwd !== 'string' || !isAbsolute(data.cwd)) {
    throw new Error('Cockpit MCP host returned an invalid session identity')
  }
}
