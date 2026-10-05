import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { StoreReadError } from '../state/read-error.ts'
import type { SubjectFingerprint } from './fingerprint.ts'

// What Cockpit itself observed about a run's result (W7.4): host check receipts, captured preview
// evidence and what a person said about it. One file per run, results/<runId>.json, with evidence
// bytes beside it in results/<runId>/. Evidence is written once under a new ID and never replaced;
// a file that is missing or no longer matches its hash is reported, not rewritten. The run's own
// identity, outcome and the agent's words are read from the conversation's events, not copied here.

export const RESULT_VERSION = 1
const RUN_ID = /^[A-Za-z0-9-]{1,80}$/
const EVIDENCE_ID = /^ev-[A-Za-z0-9-]{1,80}$/

export type CheckCriterion =
  | { readonly kind: 'exit-zero' }
  /** Exit 0 and the output includes this text. */
  | { readonly kind: 'output-includes'; readonly text: string }

export interface CheckDefinition {
  /** Shown exactly as it runs: `/bin/sh -c <command>`. */
  readonly command: string
  /** Relative to the workspace. */
  readonly cwd: string
  /** Environment variable names passed through, beyond the basic ones. */
  readonly env: readonly string[]
  readonly timeoutSec: number
  readonly criterion: CheckCriterion
  /** Workspace paths whose content the check depends on; editing one makes a result stale. */
  readonly inputs: readonly string[]
}

export type CheckOutcome = 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'error' | 'interrupted'

export interface CheckRecord {
  readonly id: string
  readonly runId: string
  readonly threadId: string
  readonly projectPath: string
  readonly workspaceId?: string
  readonly operationId: string
  readonly definition: CheckDefinition
  /** sha256 of the canonical definition and run: what was approved. */
  readonly inputHash: string
  readonly approval: { readonly by: 'user'; readonly at: string }
  /** Run by Cockpit on this Mac. Agent reports and human judgements are kept elsewhere. */
  readonly origin: 'host'
  readonly phase: 'prepared' | 'running' | 'terminal'
  readonly outcome?: CheckOutcome
  /** Why it ended as it did, in words. */
  readonly reason?: string
  readonly preparedAt: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly pid?: number
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly subject?: SubjectFingerprint
  readonly output?: { readonly evidenceId: string; readonly bytes: number; readonly truncated: boolean; readonly sha256: string }
}

export interface EvidenceRecord {
  readonly id: string
  readonly kind: 'check-output' | 'preview'
  readonly origin: 'host'
  readonly file: string
  readonly mediaType: 'text/plain' | 'image/png'
  readonly sha256: string
  readonly bytes: number
  readonly createdAt: string
  readonly checkId?: string
  readonly preview?: {
    readonly url: string
    readonly viewport: { readonly width: number; readonly height: number }
    /** The workspace state the page was served from: HEAD and uncommitted content. */
    readonly subjectDigest?: string
    readonly head?: string | null
  }
}

/** A person's own judgement of evidence. Never derived from a capture or a check. */
export interface Assessment {
  readonly id: string
  readonly evidenceId: string
  readonly by: 'human'
  readonly verdict: 'looks-right' | 'looks-wrong'
  readonly note?: string
  readonly at: string
}

export interface ResultFile {
  readonly version: number
  readonly runId: string
  readonly threadId: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly checks: readonly CheckRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly assessments: readonly Assessment[]
}

const fingerprintSchema = z.object({
  workspace: z.string(), repo: z.boolean(), head: z.string().nullable(), branch: z.string().nullable(), worktree: z.string(),
  dirtyPaths: z.number(), inputs: z.array(z.object({ path: z.string(), hash: z.string() })), digest: z.string(),
  coverage: z.object({ complete: z.boolean(), omitted: z.array(z.string()) }), takenAt: z.string(),
})
const criterionSchema = z.union([z.object({ kind: z.literal('exit-zero') }), z.object({ kind: z.literal('output-includes'), text: z.string() })])
const checkSchema = z.object({
  id: z.string(), runId: z.string(), threadId: z.string(), projectPath: z.string(), workspaceId: z.string().optional(), operationId: z.string(),
  definition: z.object({ command: z.string(), cwd: z.string(), env: z.array(z.string()), timeoutSec: z.number(), criterion: criterionSchema, inputs: z.array(z.string()) }),
  inputHash: z.string(), approval: z.object({ by: z.literal('user'), at: z.string() }), origin: z.literal('host'),
  phase: z.enum(['prepared', 'running', 'terminal']), outcome: z.enum(['passed', 'failed', 'cancelled', 'timed-out', 'error', 'interrupted']).optional(),
  reason: z.string().optional(), preparedAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(), pid: z.number().optional(),
  exitCode: z.number().nullable().optional(), signal: z.string().nullable().optional(), subject: fingerprintSchema.optional(),
  output: z.object({ evidenceId: z.string(), bytes: z.number(), truncated: z.boolean(), sha256: z.string() }).optional(),
})
const evidenceSchema = z.object({
  id: z.string().regex(EVIDENCE_ID), kind: z.enum(['check-output', 'preview']), origin: z.literal('host'), file: z.string(),
  mediaType: z.enum(['text/plain', 'image/png']), sha256: z.string(), bytes: z.number(), createdAt: z.string(), checkId: z.string().optional(),
  preview: z.object({ url: z.string(), viewport: z.object({ width: z.number(), height: z.number() }), subjectDigest: z.string().optional(), head: z.string().nullable().optional() }).optional(),
})
const assessmentSchema = z.object({ id: z.string(), evidenceId: z.string(), by: z.literal('human'), verdict: z.enum(['looks-right', 'looks-wrong']), note: z.string().optional(), at: z.string() })
const fileSchema = z.object({
  version: z.literal(RESULT_VERSION), runId: z.string(), threadId: z.string(), revision: z.number(), createdAt: z.string(), updatedAt: z.string(),
  checks: z.array(checkSchema), evidence: z.array(evidenceSchema), assessments: z.array(assessmentSchema),
})

export type EvidenceRead =
  | { readonly state: 'ok'; readonly bytes: Buffer }
  | { readonly state: 'missing' }
  /** The file no longer matches the hash recorded when it was written. */
  | { readonly state: 'corrupt' }

export interface ResultStore {
  /** Throws StoreReadError for a damaged or newer file, which is left as it is. */
  get(runId: string): ResultFile | undefined
  /** Read, change and write back one run's file; the change sees the latest copy. */
  update(runId: string, threadId: string, change: (file: ResultFile) => ResultFile): ResultFile
  /** Writes new evidence bytes; an ID already used is refused, never replaced. */
  writeEvidence(runId: string, id: string, ext: 'txt' | 'png', bytes: Buffer): { file: string; sha256: string; bytes: number }
  readEvidence(runId: string, evidence: EvidenceRecord): EvidenceRead
  /** Run IDs that have a result file. */
  runs(): string[]
}

export function createResultStore(root: string): ResultStore {
  const dir = join(root, 'results')
  const fileOf = (runId: string): string => {
    if (!RUN_ID.test(runId)) throw new Error('Not a run ID')
    return join(dir, `${runId}.json`)
  }
  const get = (runId: string): ResultFile | undefined => {
    const file = fileOf(runId)
    if (!existsSync(file)) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      throw new StoreReadError('UNREADABLE', file, error instanceof Error ? error.message : undefined)
    }
    const version = (parsed as { version?: unknown })?.version
    if (typeof version === 'number' && version > RESULT_VERSION) throw new StoreReadError('FUTURE_VERSION', file)
    const result = fileSchema.safeParse(parsed)
    if (!result.success) throw new StoreReadError('UNREADABLE', file, 'unexpected contents')
    return result.data as ResultFile
  }
  return {
    get,
    update(runId, threadId, change) {
      const now = new Date().toISOString()
      const current = get(runId) ?? { version: RESULT_VERSION, runId, threadId, revision: 0, createdAt: now, updatedAt: now, checks: [], evidence: [], assessments: [] }
      if (current.threadId !== threadId) throw new Error('That run belongs to another conversation')
      const next: ResultFile = { ...change(current), version: RESULT_VERSION, runId, threadId, revision: current.revision + 1, updatedAt: now }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = fileOf(runId)
      writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
      return next
    },
    writeEvidence(runId, id, ext, bytes) {
      if (!EVIDENCE_ID.test(id)) throw new Error('Not an evidence ID')
      const folder = join(dir, fileOf(runId).slice(dir.length + 1).replace(/\.json$/, ''))
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const name = `${id}.${ext}`
      // 'wx': evidence is written once; an existing file under this ID is never replaced.
      writeFileSync(join(folder, name), bytes, { mode: 0o600, flag: 'wx' })
      return { file: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    },
    readEvidence(runId, evidence) {
      if (!EVIDENCE_ID.test(evidence.id) || evidence.file !== `${evidence.id}.${evidence.mediaType === 'image/png' ? 'png' : 'txt'}`) return { state: 'corrupt' }
      const path = join(dir, fileOf(runId).slice(dir.length + 1).replace(/\.json$/, ''), evidence.file)
      let bytes: Buffer
      try { bytes = readFileSync(path) } catch { return { state: 'missing' } }
      return createHash('sha256').update(bytes).digest('hex') === evidence.sha256 ? { state: 'ok', bytes } : { state: 'corrupt' }
    },
    runs() {
      try { return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => RUN_ID.test(id)) } catch { return [] }
    },
  }
}
