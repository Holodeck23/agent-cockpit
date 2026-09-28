// CLI entry: `npm start` serves the cockpit on a fixed port for use in a browser.
// The desktop app (electron/main.ts) calls startServer directly on a random port.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startServer } from './start.ts'

// The MCP bundle comes from `npm run build:electron`; without it sessions just get no cockpit tools.
const mcpScript = fileURLToPath(new URL('../dist-electron/mcp.cjs', import.meta.url))

const running = await startServer({
  port: Number(process.env.COCKPIT_PORT ?? 4317),
  webDist: fileURLToPath(new URL('../dist', import.meta.url)),
  // The Vite dev server (5173) proxies to us, so its origin is trusted in development.
  trustedPorts: [5173],
  ...(existsSync(mcpScript) ? { mcp: { command: process.execPath, args: [mcpScript] } } : {}),
})
console.log(`[cockpit] ${running.url}  (threads in ${running.store.root})`)

const stop = (): void => {
  void running.close().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
