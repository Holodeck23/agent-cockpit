// Harmless local MCP server for pinned Claude readiness and actual-call probes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'w13-ping', version: '1.0.0' })
server.registerTool('ping', { title: 'Ping', description: 'Return the W13 synthetic marker.', inputSchema: {} }, async () =>
  ({ content: [{ type: 'text', text: 'W13-PONG' }] }))
await server.connect(new StdioServerTransport())
