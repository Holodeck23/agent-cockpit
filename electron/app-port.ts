import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The page's localStorage (theme, drafts, unread marks, pane layout) belongs to its
// origin, and the origin includes the port. Reusing the last port keeps all of it
// across restarts; a missing or unreadable file just means "any free port".

export function readAppPort(file: string): number | undefined {
  try {
    const port = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(port) && port > 1024 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

export function writeAppPort(file: string, port: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${port}\n`)
  } catch {
    // Only costs the next launch its remembered layout; never block startup on it.
  }
}
