// Entry point of the cockpit MCP server: one process per agent session, spawned
// by the agent CLI over stdio. Bundled to dist-electron/mcp.cjs and run by the
// app's own binary (ELECTRON_RUN_AS_NODE=1), so it needs no separate Node.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { MCP_TOKEN_ENV, MCP_URL_ENV } from './sessions.ts'
import { createCockpitApi, createCockpitMcpServer } from './tools.ts'

const baseUrl = process.env[MCP_URL_ENV]
const token = process.env[MCP_TOKEN_ENV]
if (!baseUrl || !token) {
  // stdout is the protocol channel; diagnostics go to stderr only.
  console.error(`[cockpit-mcp] ${MCP_URL_ENV} and ${MCP_TOKEN_ENV} must be set; is this running inside a Cockpit session?`)
  process.exit(1)
}

// Bundled as CommonJS, so no top-level await.
createCockpitMcpServer(createCockpitApi(baseUrl, token))
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    console.error('[cockpit-mcp] failed to start', error)
    process.exit(1)
  })
