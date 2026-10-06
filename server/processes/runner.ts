import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { GROUP_GRACE_MS, groupAlive, stopGroup } from './group.ts'
import { createOutputBuffer, detectLocalUrl, DEFAULT_OUTPUT_BYTES, type OutputBuffer, type OutputSlice } from './output.ts'

// Long-running project commands (dev servers, watchers) that an agent starts
// and then keeps an eye on. They live as long as the app does: stopped on
// request, and every one is stopped when the cockpit quits.
//
// Each process has an owner the host resolved (K1): the conversation (and run) whose agent
// started it, the person, or the project (legacy, or kept when its conversation was deleted).
// A same-name start in the same folder reuses the running process only when the command
// matches; another conversation reusing it is recorded beside the owner, never instead of it.
// Running processes are written to a ledger so a crash can be reported afterwards; recovery
// never signals a PID from the ledger, since the number may belong to another program by then.

export const startProcessSchema = z.object({
  projectPath: z.string().min(1).max(1000),
  command: z.string().trim().min(1).max(2000),
  /** Defaults to the command; a second start with the same name reuses the running one. */
  name: z.string().trim().min(1).max(60).optional(),
})
export type StartProcessInput = z.input<typeof startProcessSchema>

export type ProcessStatus = 'running' | 'stopping' | 'exited'

export type ProcessOwner =
  | { readonly kind: 'conversation'; readonly threadId: string; readonly title: string; readonly runId?: string }
  | { readonly kind: 'user' }
  /** No conversation: started before owners existed, or kept when its conversation was deleted. */
  | { readonly kind: 'project'; readonly formerly?: string }

export interface ProcessUser { readonly threadId: string; readonly title: string }

/** Same name, same folder, different command: not reused, and not started (HTTP 409). */
export class ProcessConflictError extends Error {}

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
  readonly owner: ProcessOwner
  /** Other conversations that asked for it while it ran; it stays the owner's. */
  readonly sharedWith?: readonly ProcessUser[]
  /** Cockpit quit unexpectedly while it ran; whether it still runs is unknown and it is never signalled. */
  readonly interrupted?: boolean
  /** Sent once when it leaves the finished history (Clear finished); the window drops it. */
  readonly cleared?: boolean
}

export interface ProcessRead extends OutputSlice {
  readonly process: ProcessInfo
}

export type ProcessListener = (info: ProcessInfo) => void

export interface ProcessRunner {
  /** `owner` defaults to the project (unowned). Throws ProcessConflictError for a same-name, different-command start. */
  start(input: StartProcessInput, owner?: ProcessOwner): { process: ProcessInfo; reused: boolean }
  stop(id: string): Promise<ProcessInfo>
  /** Stops it if needed and starts the same command again under the same name; returns the new process. */
  restart(id: string): Promise<ProcessInfo>
  get(id: string): ProcessInfo | undefined
  list(projectPath?: string): ProcessInfo[]
  read(id: string, options?: { since?: number; tail?: number }): ProcessRead
  subscribe(listener: ProcessListener): () => void
  /** Running or stopping processes this conversation owns. */
  ownedBy(threadId: string): ProcessInfo[]
  /** Its conversation is being deleted: stop what it owns, or keep it as project processes. Never another conversation's. */
  release(threadId: string, how: 'stop' | 'keep'): Promise<ProcessInfo[]>
  /** Drops finished rows from the history kept for this folder. Never stops anything. */
  clearFinished(projectPath: string): number
  /** Stops every process group this runner started; resolves once they are gone. */
  shutdown(): Promise<void>
}

export interface RunnerOptions {
  readonly graceMs?: number
  readonly maxOutputBytes?: number
  /** Exited entries kept for reading after the fact. */
  readonly keepExited?: number
  /** Where running processes are recorded, so a crash can be reported on the next start. */
  readonly ledgerFile?: string
  /** Source environment; injectable so the boundary can be tested without changing process.env. */
  readonly env?: NodeJS.ProcessEnv
}

const PROJECT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'] as const

/**
 * Long-running project commands get normal shell basics, not Cockpit's credentials,
 * Electron controls, debug hooks, or agent-provider tokens. Projects can still load
 * their own .env files or name variables explicitly in the command the user approves.
 */
export function projectProcessEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' }
  for (const name of PROJECT_ENV) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface Entry {
  readonly info: ProcessInfo
  /** Absent for a process recovered from the ledger: Cockpit no longer holds it. */
  readonly child?: ChildProcess
  readonly output: OutputBuffer
}

const ledgerSchema = z.object({
  version: z.literal(1),
  processes: z.array(z.object({
    id: z.string(), name: z.string(), command: z.string(), projectPath: z.string(), pid: z.number().optional(),
    startedAt: z.string(), owner: z.any().optional(), sharedWith: z.array(z.object({ threadId: z.string(), title: z.string() })).optional(),
  })),
})

export function createProcessRunner(options: RunnerOptions = {}): ProcessRunner {
  const graceMs = options.graceMs ?? GROUP_GRACE_MS
  const keepExited = options.keepExited ?? 30
  const entries = new Map<string, Entry>()
  const listeners = new Set<ProcessListener>()
  let counter = 0
  // Unique across launches, so a recovered entry never shares an ID with a new one.
  const launch = Date.now().toString(36)

  // The ledger: running processes only. An unreadable one is left exactly as found and not rewritten.
  const ledgerFile = options.ledgerFile
  let ledgerWritable = Boolean(ledgerFile)
  const writeLedger = (): void => {
    if (!ledgerFile || !ledgerWritable) return
    const live = [...entries.values()].filter((e) => e.child && e.info.status !== 'exited').map(({ info }) => ({
      id: info.id, name: info.name, command: info.command, projectPath: info.projectPath, ...(info.pid ? { pid: info.pid } : {}),
      startedAt: info.startedAt, owner: info.owner, ...(info.sharedWith ? { sharedWith: info.sharedWith } : {}),
    }))
    try {
      writeFileSync(`${ledgerFile}.tmp`, JSON.stringify({ version: 1, processes: live }), { mode: 0o600 })
      renameSync(`${ledgerFile}.tmp`, ledgerFile)
    } catch (error) {
      console.warn('[cockpit] the process ledger was not written:', error instanceof Error ? error.message : error)
    }
  }

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
    if (patch.status || patch.owner || patch.sharedWith) writeLedger()
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
    // A recovered entry's PID may belong to another program now: it is never signalled.
    const child = entry.child
    if (!child) return entry.info
    if (!pid || (entry.info.status === 'exited' && !groupAlive(pid))) return entry.info
    if (entry.info.status === 'running') update(id, { status: 'stopping' })
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('close', () => resolve())
    })
    await stopGroup(pid, graceMs)
    // A daemon that escaped the group can hold the pipes open; don't wait on it forever.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))])
    return entryOf(id).info
  }

  const runner: ProcessRunner = {
    start(input, owner = { kind: 'project' }) {
      const { projectPath, command, name: givenName } = startProcessSchema.parse(input)
      if (!isDirectory(projectPath)) throw new Error(`Not a folder on this computer: ${projectPath}`)
      const name = givenName ?? command
      // Within one folder (a worktree is its own folder), a running same-name process is reused only for the same command.
      const same = [...entries.values()].find((entry) => entry.child && entry.info.projectPath === projectPath && entry.info.name === name && entry.info.status !== 'exited')
      if (same) {
        if (same.info.command !== command) {
          throw new ProcessConflictError(`“${name}” is already running here with a different command (${same.info.command}). Stop it first, or use another name.`)
        }
        if (owner.kind === 'conversation' && !(same.info.owner.kind === 'conversation' && same.info.owner.threadId === owner.threadId)
          && !same.info.sharedWith?.some((u) => u.threadId === owner.threadId)) {
          update(same.info.id, { sharedWith: [...(same.info.sharedWith ?? []), { threadId: owner.threadId, title: owner.title }] })
        }
        return { process: entryOf(same.info.id).info, reused: true }
      }

      const id = `proc-${launch}-${++counter}`
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: projectPath,
        // Own process group, so stop() can take down everything the command forks.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // BROWSER=none: dev servers must not pop a browser; open_preview does that on request.
        env: projectProcessEnvironment(options.env),
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
        owner,
      }
      entries.set(id, { info, child, output })
      writeLedger()

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

    // Same folder, name, command and owner; a new process ID.
    async restart(id) {
      const { projectPath, command, name, owner, sharedWith } = entryOf(id).info
      await stop(id)
      const { process } = runner.start({ projectPath, command, name }, owner)
      if (sharedWith?.length) update(process.id, { sharedWith })
      return entryOf(process.id).info
    },

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

    ownedBy: (threadId) => [...entries.values()].map((e) => e.info)
      .filter((info) => info.status !== 'exited' && info.owner.kind === 'conversation' && info.owner.threadId === threadId),

    async release(threadId, how) {
      const owned = runner.ownedBy(threadId)
      if (how === 'stop') return Promise.all(owned.map((info) => stop(info.id)))
      for (const info of owned) {
        const formerly = info.owner.kind === 'conversation' ? info.owner.title : undefined
        update(info.id, { owner: { kind: 'project', ...(formerly ? { formerly } : {}) } })
      }
      return owned.map((info) => entryOf(info.id).info)
    },

    clearFinished(projectPath) {
      const finished = [...entries.values()].filter((e) => e.info.projectPath === projectPath && e.info.status === 'exited')
      for (const entry of finished) {
        entries.delete(entry.info.id)
        for (const listener of listeners) listener({ ...entry.info, cleared: true })
      }
      return finished.length
    },

    async shutdown() {
      await Promise.all([...entries.keys()].map((id) => stop(id)))
    },
  }

  // What the last launch left running, reported as interrupted (ID-07). Nothing is signalled or restarted.
  if (ledgerFile && existsSync(ledgerFile)) {
    try {
      const ledger = ledgerSchema.parse(JSON.parse(readFileSync(ledgerFile, 'utf8')))
      const endedAt = new Date().toISOString()
      for (const p of ledger.processes) {
        const output = createOutputBuffer(options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES)
        output.push('stderr', `[cockpit] Cockpit quit unexpectedly while this ran${p.pid ? ` as process ${p.pid}` : ''}. It may still be running; Cockpit does not stop it, because that number may now belong to another program.\n`)
        const owner = (p.owner && typeof p.owner === 'object' && 'kind' in p.owner ? p.owner : { kind: 'project' }) as ProcessOwner
        entries.set(p.id, { info: { id: p.id, name: p.name, command: p.command, projectPath: p.projectPath, status: 'exited', ...(p.pid ? { pid: p.pid } : {}),
          startedAt: p.startedAt, endedAt, exitCode: null, signal: null, owner, ...(p.sharedWith ? { sharedWith: p.sharedWith } : {}), interrupted: true }, output })
      }
      writeLedger()
    } catch (error) {
      ledgerWritable = false
      console.warn(`[cockpit] ${ledgerFile} could not be read; it is left as it is and not rewritten:`, error instanceof Error ? error.message : error)
    }
  }
  return runner
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
