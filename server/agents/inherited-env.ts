import { MCP_TOKEN_ENV, MCP_URL_ENV } from '../mcp/sessions.ts'

/**
 * Cockpit's own environment for a child it starts, without a Cockpit MCP address or token it may
 * have inherited (a Cockpit started from another Cockpit's conversation). A child gets this
 * Cockpit's token only when a launcher passes it on purpose, for a project that opted in.
 */
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { [MCP_URL_ENV]: _url, [MCP_TOKEN_ENV]: _token, ...rest } = env
  return rest
}
