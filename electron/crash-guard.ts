import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

// Cockpit's server runs inside Electron's main process. Left alone, an uncaught error there shows
// Electron's modal "A JavaScript error occurred in the main process" dialog, which blocks the whole
// process: the window, the phone and every agent session freeze until someone clicks it (order 14
// found this with a phone that dropped a preview socket). The guard writes the error to a log the
// person can attach to a report, says so on stderr, and keeps Cockpit running. It does not hide
// errors: each one is in the log with its stack.

export const LOG_LIMIT = 1024 * 1024

export interface CrashLog {
  /** How many errors were written this run. */
  count(): number
}

/** Writes one entry, moving a full log to `<file>.1` first. Never throws: a guard that crashes guards nothing. */
function write(file: string, entry: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try { if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`) } catch { /* no log yet */ }
    appendFileSync(file, entry, { mode: 0o600 })
  } catch { /* the disk is not writable: stderr still has it */ }
}

const describe = (error: unknown): string => (error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error))

export function installCrashGuard(target: NodeJS.EventEmitter, file: string, now: () => Date = () => new Date()): CrashLog {
  let count = 0
  const record = (kind: string, error: unknown): void => {
    count += 1
    const entry = `${now().toISOString()} ${kind}\n${describe(error)}\n\n`
    console.error(`[cockpit] ${kind} (kept running; details in ${file}):`, error)
    write(file, entry)
  }
  target.on('uncaughtException', (error: unknown, origin: string) => record(origin === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception', error))
  target.on('unhandledRejection', (reason: unknown) => record('unhandled rejection', reason))
  return { count: () => count }
}
