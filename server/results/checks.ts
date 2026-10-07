import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { z } from 'zod'
import type { Observation } from '../git/observe.ts'
import { GROUP_GRACE_MS, stopGroup } from '../processes/group.ts'
import { stripAnsi } from '../processes/output.ts'
import { MAX_DECLARED_INPUTS, safeInputPath, takeFingerprint } from './fingerprint.ts'
import type { CheckDefinition, CheckOutcome, CheckRecord, ResultStore } from './store.ts'

// Finite host checks (W7.4): one command a person approved, exactly as shown, run once to an end.
// Separate from dev servers (../processes/runner.ts), but stopped the same way, as a process group.
// The receipt is written before the command starts and its terminal state before anyone can see
// an outcome. A cancelled or timed-out check stays that, whatever exit code arrives afterwards.

export const MAX_STORED_OUTPUT = 64 * 1024
const MAX_HELD_OUTPUT = 4 * 1024 * 1024
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export const checkDefinitionSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  cwd: z.string().trim().max(500).default('.'),
  env: z.array(z.string().regex(ENV_NAME)).max(20).default([]),
  timeoutSec: z.number().int().min(1).max(3600).default(120),
  criterion: z.union([
    z.object({ kind: z.literal('exit-zero') }),
    z.object({ kind: z.literal('output-includes'), text: z.string().min(1).max(200) }),
  ]).default({ kind: 'exit-zero' }),
  inputs: z.array(z.string().min(1).max(500)).max(MAX_DECLARED_INPUTS).default([]),
})
export type CheckDefinitionInput = z.input<typeof checkDefinitionSchema>

/** The same operation ID sent again with a different check (409). */
export class CheckConflictError extends Error {}

export function canonicalCheckHash(runId: string, definition: CheckDefinition): string {
  const { command, cwd, env, timeoutSec, criterion, inputs } = definition
  return createHash('sha256').update(JSON.stringify({ runId, command, cwd, env: [...env].sort(), timeoutSec, criterion, inputs: [...inputs].sort() })).digest('hex')
}

const SECRET_TOKENS = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g
const SECRET_ASSIGN = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"']+\2/gi

/** Output as stored: likely credentials replaced, including the values of passed-through variables. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(SECRET_TOKENS, '[redacted]').replace(SECRET_ASSIGN, '$1[redacted]')
  for (const value of secrets) if (value.length >= 6) out = out.split(value).join('[redacted]')
  return out
}

export interface StartCheck {
  readonly runId: string
  readonly threadId: string
  readonly projectPath: string
  readonly workspaceId?: string
  /** The workspace folder the check runs in; defaults to the project folder. */
  readonly cwd?: string
  readonly operationId: string
  readonly definition: CheckDefinitionInput
}

export interface CheckRunner {
  /** Resolves once the receipt says it is running (or already ended). */
  start(input: StartCheck): Promise<CheckRecord>
  /** Stops its process group; it ends as cancelled even if a zero exit arrives late. */
  cancel(checkId: string): Promise<CheckRecord | undefined>
  /** The parent conversation was stopped: its checks are cancelled. */
  /** With `runIds`, only checks of those runs (one workspace's Stop). */
  cancelForThread(threadId: string, runIds?: ReadonlySet<string>): Promise<void>
  isLive(checkId: string): boolean
  /** Resolves once the check has a terminal receipt (tests). */
  settled(checkId: string): Promise<void>
  shutdown(): Promise<void>
}

interface Live {
  readonly threadId: string
  readonly runId: string
  pid?: number
  cancelled: boolean
  timedOut: boolean
  readonly done: Promise<void>
}

export function createCheckRunner(store: ResultStore, options: { look?: (path: string) => Promise<Observation>; graceMs?: number; now?: () => string } = {}): CheckRunner {
  const graceMs = options.graceMs ?? GROUP_GRACE_MS
  const now = options.now ?? (() => new Date().toISOString())
  const live = new Map<string, Live>()

  const save = (record: CheckRecord): CheckRecord => {
    store.update(record.runId, record.threadId, (file) => ({ ...file, checks: [...file.checks.filter((c) => c.id !== record.id), record] }))
    return record
  }
  const find = (runId: string, id: string): CheckRecord | undefined => store.get(runId)?.checks.find((c) => c.id === id)

  const resolveCwd = (projectPath: string, cwd: string): string => {
    const relative = cwd === '.' || cwd === '' ? '.' : safeInputPath(cwd)
    if (!relative) throw new Error(`The check's folder must be inside the workspace: ${cwd}`)
    const root = realpathSync(projectPath)
    const full = relative === '.' ? root : realpathSync(join(projectPath, relative))
    if (full !== root && !full.startsWith(root + sep)) throw new Error(`The check's folder must be inside the workspace: ${cwd}`)
    if (!statSync(full).isDirectory()) throw new Error(`Not a folder: ${cwd}`)
    return full
  }

  const runner: CheckRunner = {
    async start(input) {
      const definition = checkDefinitionSchema.parse(input.definition) as CheckDefinition
      for (const path of definition.inputs) if (!safeInputPath(path)) throw new Error(`A declared input must be inside the workspace: ${path}`)
      const inputHash = canonicalCheckHash(input.runId, definition)
      // Idempotence: the same operation ID returns its receipt; with another check it is refused.
      const earlier = store.get(input.runId)?.checks.find((c) => c.operationId === input.operationId)
      if (earlier) {
        if (earlier.inputHash !== inputHash) throw new CheckConflictError('That operation ID was already used for a different check')
        return earlier
      }
      const root = input.cwd ?? input.projectPath
      const cwd = resolveCwd(root, definition.cwd)
      const id = `chk-${randomUUID()}`
      // What it runs against, read before it starts.
      const subject = await takeFingerprint(root, definition.inputs, ...(options.look ? [options.look] : []))
      const prepared = save({
        id, runId: input.runId, threadId: input.threadId, projectPath: input.projectPath, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        operationId: input.operationId, definition, inputHash, approval: { by: 'user', at: now() }, origin: 'host', phase: 'prepared', preparedAt: now(), subject,
      })

      const env: Record<string, string> = { FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }
      const secrets: string[] = []
      for (const name of [...BASE_ENV, ...definition.env]) {
        const value = process.env[name]
        if (value === undefined) continue
        env[name] = value
        if (definition.env.includes(name)) secrets.push(value)
      }

      let held = ''
      let heldTruncated = false
      let carry = ''
      let matched = false
      const wanted = definition.criterion.kind === 'output-includes' ? definition.criterion.text : undefined
      const take = (chunk: string): void => {
        const text = stripAnsi(chunk)
        if (wanted && !matched) {
          const joined = carry + text
          if (joined.includes(wanted)) matched = true
          carry = joined.slice(-(wanted.length - 1) || joined.length)
        }
        held += text
        if (held.length > MAX_HELD_OUTPUT) { held = held.slice(-MAX_HELD_OUTPUT); heldTruncated = true }
      }

      let resolveDone!: () => void
      const entry: Live = { threadId: input.threadId, runId: input.runId, cancelled: false, timedOut: false, done: new Promise<void>((r) => { resolveDone = r }) }
      live.set(id, entry)

      let terminal = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: CheckOutcome, reason: string, exitCode: number | null, signal: string | null): void => {
        // Exactly one terminal receipt.
        if (terminal) return
        terminal = true
        clearTimeout(timer)
        const stored = redact(held, secrets)
        const storedBytes = Buffer.from(stored, 'utf8')
        const tail = storedBytes.length > MAX_STORED_OUTPUT ? storedBytes.subarray(storedBytes.length - MAX_STORED_OUTPUT) : storedBytes
        const truncated = heldTruncated || tail.length < storedBytes.length
        let output: CheckRecord['output']
        try {
          const evidenceId = `ev-${randomUUID()}`
          const written = store.writeEvidence(input.runId, evidenceId, 'txt', tail)
          store.update(input.runId, input.threadId, (file) => ({ ...file, evidence: [...file.evidence, { id: evidenceId, kind: 'check-output', origin: 'host', file: written.file, mediaType: 'text/plain', sha256: written.sha256, bytes: written.bytes, createdAt: now(), checkId: id }] }))
          output = { evidenceId, bytes: written.bytes, truncated, sha256: written.sha256 }
        } catch (error) {
          console.warn('[cockpit] a check’s output was not stored:', error instanceof Error ? error.message : error)
        }
        const current = find(input.runId, id) ?? prepared
        save({ ...current, phase: 'terminal', outcome, reason, endedAt: now(), exitCode, signal, ...(output ? { output } : {}) })
        live.delete(id)
        resolveDone()
      }

      let child
      try {
        child = spawn('/bin/sh', ['-c', definition.command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } catch (error) {
        finish('error', `Could not start: ${error instanceof Error ? error.message : String(error)}`, null, null)
        return find(input.runId, id)!
      }
      const pid = child.pid
      entry.pid = pid
      timer = setTimeout(() => {
        if (terminal) return
        entry.timedOut = true
        if (pid) void stopGroup(pid, graceMs)
      }, definition.timeoutSec * 1000)
      child.stdout?.setEncoding('utf8').on('data', take)
      child.stderr?.setEncoding('utf8').on('data', take)
      child.on('error', (error) => finish('error', `Could not start: ${error.message}`, null, null))
      let exited: { code: number | null; signal: string | null } | undefined
      const conclude = (): void => {
        const { code, signal } = exited ?? { code: null, signal: null }
        if (entry.cancelled) return finish('cancelled', 'Cancelled before it finished; a later exit code does not count.', code, signal)
        if (entry.timedOut) return finish('timed-out', `Ran past its ${definition.timeoutSec}s limit and was stopped.`, code, signal)
        if (code !== 0 || signal) return finish('failed', signal ? `Ended by ${signal}.` : `Exited with code ${code}.`, code, signal)
        if (wanted && !matched) return finish('failed', `Exited with code 0, but the output did not include “${wanted}”.`, code, signal)
        return finish('passed', wanted ? `Exited with code 0 and the output included “${wanted}”.` : 'Exited with code 0.', code, signal)
      }
      child.on('exit', (code, signal) => {
        exited = { code, signal }
        // A finite check owns its whole group: anything it left behind is stopped before it ends.
        void (async () => {
          if (pid) await stopGroup(pid, graceMs)
          // A daemon that escaped the group can hold the pipes open; don't wait on it forever.
          setTimeout(conclude, graceMs)
        })()
      })
      child.on('close', () => { if (exited) conclude() })

      return save({ ...find(input.runId, id)!, phase: 'running', startedAt: now(), ...(pid ? { pid } : {}) })
    },

    async cancel(checkId) {
      const entry = live.get(checkId)
      if (!entry) {
        for (const runId of store.runs()) {
          const found = store.get(runId)?.checks.find((c) => c.id === checkId)
          if (found) return found
        }
        return undefined
      }
      // Set before anything else: an exit that races the stop still ends as cancelled.
      entry.cancelled = true
      if (entry.pid) await stopGroup(entry.pid, graceMs)
      await entry.done
      return find(entry.runId, checkId)
    },

    async cancelForThread(threadId, runIds) {
      await Promise.all([...live].filter(([, e]) => e.threadId === threadId && (!runIds || runIds.has(e.runId))).map(([id]) => runner.cancel(id)))
    },

    isLive: (checkId) => live.has(checkId),

    async settled(checkId) { await live.get(checkId)?.done },

    async shutdown() {
      await Promise.all([...live.keys()].map((id) => runner.cancel(id)))
    },
  }
  return runner
}
