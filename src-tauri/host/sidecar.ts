// The Tauri shell's backend: the same loopback server as the Electron app, run by the Node
// binary bundled inside Cockpit.app (Contents/MacOS/node), so it works from Finder with no Node
// on PATH. Bundled to dist-tauri/sidecar.cjs by scripts/build-tauri-host.ts.
//
// Talks to the shell over its own stdio only, as JSON lines:
//   stdout  "@@cockpit {…}"  ready (url, port, one-time window entry) and page events
//   stdin   {"type":"quit"}  or EOF: stop every agent and process, then exit
// The window key itself never leaves this process except as the entry's HttpOnly cookie.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { startServer, type RunningServer } from '../../server/start.ts'
import { defaultRoot } from '../../server/threads/store.ts'
import { readAppPort, writeAppPort } from '../../electron/app-port.ts'
import { resolveAppPath } from '../../electron/shell-path.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'

// Longer than both stop ladders (see electron/main.ts), so nothing hung is orphaned.
const SHUTDOWN_GRACE_MS = 5000
const CONTROL = '@@cockpit '

/** Where the shell put the web build and the MCP entry: next to this file. */
const here = __dirname

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${CONTROL}${JSON.stringify(message)}\n`)
}

let running: RunningServer | undefined
let stopping: Promise<void> | undefined

function stop(reason: string): Promise<void> {
  stopping ??= (async () => {
    console.error(`[cockpit-host] stopping (${reason})`)
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
    await Promise.race([running?.close() ?? Promise.resolve(), grace])
    send({ type: 'stopped' })
    process.exit(0)
  })()
  return stopping
}

async function main(): Promise<void> {
  process.env.PATH = resolveAppPath().path
  const portFile = join(defaultRoot(), 'app-port')
  const windowKey = randomBytes(32).toString('hex')
  const windowEntry = randomBytes(32).toString('hex')
  running = await startServer({
    port: 0,
    preferredPort: readAppPort(portFile),
    webDist: join(here, 'dist'),
    // process.execPath is the bundled Node itself: the replacement for ELECTRON_RUN_AS_NODE.
    mcp: { command: process.execPath, args: [join(here, 'mcp.cjs')] },
    // open_preview reaches the page through the shell, which forwards it as a page event.
    openUrl: (preview: PreviewOpen) => { send({ type: 'preview-open', preview }) },
    windowKey,
    windowEntry,
  })
  writeAppPort(portFile, running.port)
  send({ type: 'ready', url: running.url, port: running.port, entry: windowEntry })
}

// The shell's pipe closing means the shell is gone: never outlive it.
createInterface({ input: process.stdin })
  .on('line', (line) => {
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === 'quit') void stop('quit')
    } catch { /* not a command */ }
  })
  .on('close', () => void stop('shell closed'))
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))

main().catch((error: unknown) => {
  send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
