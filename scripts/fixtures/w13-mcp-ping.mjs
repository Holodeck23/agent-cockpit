// Harmless local MCP server for pinned Claude readiness and actual-call probes. W13_PING_MARKER, when set
// in its definition, replaces the fixed answer, so a proof can tell a real call from a guess.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'w13-ping', version: '1.0.0' })
server.registerTool('ping', { title: 'Ping', description: 'Return the W13 synthetic marker.', inputSchema: {} }, async () =>
  ({ content: [{ type: 'text', text: process.env.W13_PING_MARKER || 'W13-PONG' }] }))
await server.connect(new StdioServerTransport())
