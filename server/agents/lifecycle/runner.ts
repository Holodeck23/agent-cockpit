// Runs one installer, updater or sign-in helper as Cockpit's own process group: output is streamed
// line by line (redacted), bounded in memory and kept in a log file; Cancel ends the whole group
// and nothing else; a hard time limit bounds a silent or stuck helper.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { redactSecrets } from './redact.ts'

const MAX_LINES = 400
const MAX_LINE = 2000
const KILL_AFTER_MS = 3000

export interface HelperExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly cancelled: boolean
  readonly timedOut: boolean
  /** Spawn failure, e.g. ENOENT. */
  readonly error?: string
}

export interface HelperRun {
  readonly lines: readonly string[]
  /** Input for the helper (a pasted sign-in code). Never logged or kept. */
  write(text: string): void
  cancel(): void
  readonly done: Promise<HelperExit>
}

export interface HelperSpec {
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly timeoutMs: number
  /** Keep stdin open for input (sign-in); otherwise the helper sees end of input. */
  readonly input?: boolean
  readonly logFile: string
  readonly onLine?: (line: string) => void
}

export function runHelper(spec: HelperSpec): HelperRun {
  const lines: string[] = []
  let cancelled = false
  let timedOut = false
  const add = (raw: string): void => {
    const line = redactSecrets(raw).slice(0, MAX_LINE)
    if (!line.trim()) return
    lines.push(line)
    if (lines.length > MAX_LINES) lines.shift()
    try { appendFileSync(spec.logFile, `${line}\n`, { mode: 0o600 }) } catch { /* the in-memory tail still shows it */ }
    spec.onLine?.(line)
  }
  const child = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd, env: { ...spec.env }, detached: true, stdio: [spec.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const split = (stream: NodeJS.ReadableStream | null): void => {
    let partial = ''
    stream?.setEncoding?.('utf8')
    stream?.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/\r\n|\n|\r/)
      partial = parts.pop() ?? ''
      for (const part of parts) add(part)
    })
    stream?.on('end', () => { if (partial) add(partial); partial = '' })
  }
  split(child.stdout)
  split(child.stderr)
  const group = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch { /* already gone */ }
  }
  let killTimer: NodeJS.Timeout | undefined
  const stop = (): void => {
    group('SIGTERM')
    killTimer = setTimeout(() => group('SIGKILL'), KILL_AFTER_MS)
  }
  const limit = setTimeout(() => { timedOut = true; stop() }, spec.timeoutMs)
  const done = new Promise<HelperExit>((resolve) => {
    child.on('error', (error) => {
      clearTimeout(limit)
      resolve({ code: null, signal: null, cancelled, timedOut, error: (error as NodeJS.ErrnoException).code ?? error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(limit)
      // Whatever the helper left running in its group goes with it.
      group('SIGKILL')
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, signal, cancelled, timedOut })
    })
  })
  return {
    lines,
    write(text) { if (child.stdin?.writable) child.stdin.write(text) },
    cancel() { if (!cancelled) { cancelled = true; stop() } },
    done,
  }
}
