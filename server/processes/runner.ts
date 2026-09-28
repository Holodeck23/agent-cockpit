import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { z } from 'zod'
import { GROUP_GRACE_MS, groupAlive, stopGroup } from './group.ts'
import { createOutputBuffer, detectLocalUrl, DEFAULT_OUTPUT_BYTES, type OutputBuffer, type OutputSlice } from './output.ts'

// Long-running project commands (dev servers, watchers) that an agent starts
// and then keeps an eye on. They live as long as the app does: stopped on
// request, and every one is stopped when the cockpit quits.

export const startProcessSchema = z.object({
  projectPath: z.string().min(1).max(1000),
  command: z.string().trim().min(1).max(2000),
  /** Defaults to the command; a second start with the same name reuses the running one. */
  name: z.string().trim().min(1).max(60).optional(),
})
export type StartProcessInput = z.input<typeof startProcessSchema>

export type ProcessStatus = 'running' | 'stopping' | 'exited'

export interface ProcessInfo {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly projectPath: string
  readonly status: ProcessStatus
  readonly pid?: number
  readonly startedAt: string
  readonly endedAt?: string
  readonly exitCode: number | null
  readonly signal: string | null
  /** First local URL the process printed, e.g. a dev server's "Local:" line. */
  readonly url?: string
}

export interface ProcessRead extends OutputSlice {
  readonly process: ProcessInfo
}

export type ProcessListener = (info: ProcessInfo) => void

export interface ProcessRunner {
  start(input: StartProcessInput): { process: ProcessInfo; reused: boolean }
  stop(id: string): Promise<ProcessInfo>
  get(id: string): ProcessInfo | undefined
  list(projectPath?: string): ProcessInfo[]
  read(id: string, options?: { since?: number; tail?: number }): ProcessRead
  subscribe(listener: ProcessListener): () => void
  /** Stops every process group this runner started; resolves once they are gone. */
  shutdown(): Promise<void>
}

export interface RunnerOptions {
  readonly graceMs?: number
  readonly maxOutputBytes?: number
  /** Exited entries kept for reading after the fact. */
  readonly keepExited?: number
}

interface Entry {
  readonly info: ProcessInfo
  readonly child: ChildProcess
  readonly output: OutputBuffer
}

export function createProcessRunner(options: RunnerOptions = {}): ProcessRunner {
  const graceMs = options.graceMs ?? GROUP_GRACE_MS
  const keepExited = options.keepExited ?? 30
  const entries = new Map<string, Entry>()
  const listeners = new Set<ProcessListener>()
  let counter = 0

  const entryOf = (id: string): Entry => {
    const entry = entries.get(id)
    if (!entry) throw new Error(`No process with id ${id}`)
    return entry
  }

  const update = (id: string, patch: Partial<ProcessInfo>): void => {
    const entry = entries.get(id)
    if (!entry) return
    const info: ProcessInfo = { ...entry.info, ...patch }
    entries.set(id, { ...entry, info })
    for (const listener of listeners) listener(info)
  }

  const pruneExited = (): void => {
    const exited = [...entries.values()].filter((entry) => entry.info.status === 'exited')
    for (const entry of exited.slice(0, Math.max(0, exited.length - keepExited))) entries.delete(entry.info.id)
  }

  const onLines = (id: string, lines: readonly { text: string }[]): void => {
    if (entries.get(id)?.info.url) return
    for (const line of lines) {
      const url = detectLocalUrl(line.text)
      if (url) return update(id, { url })
    }
  }

  const byStartDesc = (a: ProcessInfo, b: ProcessInfo): number => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)

  const stop = async (id: string): Promise<ProcessInfo> => {
    const entry = entryOf(id)
    const pid = entry.info.pid
    if (!pid || (entry.info.status === 'exited' && !groupAlive(pid))) return entry.info
    if (entry.info.status === 'running') update(id, { status: 'stopping' })
    const exited = new Promise<void>((resolve) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) resolve()
      else entry.child.once('close', () => resolve())
    })
    await stopGroup(pid, graceMs)
    // A daemon that escaped the group can hold the pipes open; don't wait on it forever.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))])
    return entryOf(id).info
  }

  return {
    start(input) {
      const { projectPath, command, name: givenName } = startProcessSchema.parse(input)
      if (!isDirectory(projectPath)) throw new Error(`Not a folder on this computer: ${projectPath}`)
      const name = givenName ?? command
      const same = [...entries.values()].find((entry) => entry.info.projectPath === projectPath && entry.info.name === name)
      if (same && same.info.status !== 'exited') return { process: same.info, reused: true }
      if (same) entries.delete(same.info.id)

      const id = `proc-${++counter}`
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: projectPath,
        // Own process group, so stop() can take down everything the command forks.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // BROWSER=none: dev servers must not pop a browser; open_preview does that on request.
        env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
      })
      const output = createOutputBuffer(options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES)
      const info: ProcessInfo = {
        id,
        name,
        command,
        projectPath,
        status: 'running',
        ...(child.pid ? { pid: child.pid } : {}),
        startedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
      }
      entries.set(id, { info, child, output })

      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => onLines(id, output.push('stdout', chunk)))
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => onLines(id, output.push('stderr', chunk)))
      child.on('error', (error) => {
        output.push('stderr', `[cockpit] could not start: ${error.message}\n`)
        update(id, { status: 'exited', endedAt: new Date().toISOString() })
      })
      child.on('close', (code, signal) => {
        onLines(id, output.flush())
        update(id, { status: 'exited', exitCode: code, signal, endedAt: new Date().toISOString() })
        pruneExited()
      })
      for (const listener of listeners) listener(info)
      return { process: info, reused: false }
    },

    stop,

    get: (id) => entries.get(id)?.info,

    list(projectPath) {
      return [...entries.values()]
        .map((entry) => entry.info)
        .filter((info) => projectPath === undefined || info.projectPath === projectPath)
        .sort(byStartDesc)
    },

    read(id, readOptions) {
      const entry = entryOf(id)
      return { process: entry.info, ...entry.output.read(readOptions) }
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async shutdown() {
      await Promise.all([...entries.keys()].map((id) => stop(id)))
    },
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
