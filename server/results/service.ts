import { randomUUID } from 'node:crypto'
import { observe, type Observation } from '../git/observe.ts'
import { isRefusal, workspaceFolder, type WorkspaceLookup } from '../projects/resolve.ts'
import type { RunObservationStore } from '../runs/observations.ts'
import { runChanges, type RunChanges } from '../runs/run-changes.ts'
import { StoreReadError } from '../state/read-error.ts'
import { bindingIdOf, runsOf, type RunOutcome } from '../threads/identity.ts'
import type { StoredEvent, ThreadMeta } from '../threads/types.ts'
import type { CheckRunner } from './checks.ts'
import { fingerprintOf, freshness, type Freshness } from './fingerprint.ts'
import { RESULT_VERSION, type Assessment, type CheckRecord, type EvidenceRecord, type ResultFile, type ResultStore } from './store.ts'

// A run's result card (W7.4): Changes, Checks, Preview and Gaps, each from its own source.
// The run's identity and outcome come from the conversation's events; changes from the run's
// before/after observations; checks and previews from Cockpit's own receipts; judgements from a
// person. What the agent said is shown as the agent's words and never counts as a check. A card
// with nothing recorded says so: absence is not green, and a capture is not a visual pass.

export interface CheckView extends CheckRecord {
  readonly freshness?: Freshness
}

export interface PreviewView extends EvidenceRecord {
  readonly integrity: 'ok' | 'missing' | 'corrupt'
  readonly assessments: readonly Assessment[]
}

export interface ResultView {
  readonly version: number
  readonly runId: string
  readonly threadId: string
  readonly identity: {
    readonly projectPath: string
    readonly workspaceId?: string
    readonly bindingId: string
    readonly agent: string
    readonly model?: string
    /** No account profiles yet: the agent's own signed-in default. */
    readonly account: 'default'
    readonly profile: 'standard'
  }
  readonly request: { readonly eventIndex: number; readonly operationId?: string; readonly excerpt: string; readonly at: string }
  /** The provider's own end of the run; not the person's Complete and not a check. */
  readonly provider: { readonly state: 'working' | RunOutcome; readonly endedAt?: string }
  /** The person marked the conversation complete. */
  readonly complete: boolean
  readonly changes: RunChanges
  readonly checks: readonly CheckView[]
  readonly previews: readonly PreviewView[]
  /** The agent's closing words, labelled as the agent's: never evidence on their own. */
  readonly agentReport?: string
  readonly gaps: readonly string[]
  /** The stored result could not be read; it is left untouched and nothing new is recorded. */
  readonly recordError?: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ResultDeps {
  readonly store: ResultStore
  readonly checks: CheckRunner
  readonly runs?: RunObservationStore
  readonly observing?: (runId: string) => boolean
  readonly look?: (path: string) => Promise<Observation>
  /** Resolves a workspace to its folder; without it every run is read in the project folder. */
  readonly workspace?: WorkspaceLookup
  readonly capturePreview?: (url: string) => Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }>
}

export class UnknownRunError extends Error {}

const outcomeWord: Record<string, string> = {
  failed: 'failed', cancelled: 'was cancelled', 'timed-out': 'timed out', error: 'could not run', interrupted: 'was interrupted when Cockpit quit',
}

function agentAt(meta: ThreadMeta, events: readonly StoredEvent[], index: number): string {
  const switches = events.map((e) => e.event).filter((e): e is Extract<StoredEvent['event'], { kind: 'agent_switch' }> => e.kind === 'agent_switch')
  let agent: string = switches[0]?.from ?? meta.settings.agent
  for (const { event } of events.slice(0, index)) if (event.kind === 'agent_switch') agent = event.to
  return agent
}

function bindingAt(meta: ThreadMeta, events: readonly StoredEvent[], index: number): string {
  const event = events[index]?.event
  if (event?.kind === 'user_text' && event.binding?.bindingId) return event.binding.bindingId
  for (let i = index; i >= 0; i--) {
    const e = events[i]!.event
    if (e.kind === 'session_boundary' && e.bindingId) return e.bindingId
  }
  return bindingIdOf(meta)
}

export function createResultService(deps: ResultDeps) {
  const look = deps.look ?? observe
  /** The folder of a conversation's workspace; undefined once it is gone: never the primary in its place. */
  const folderOf = (meta: ThreadMeta, workspaceId: string | undefined): string | undefined => {
    const folder = workspaceFolder(deps.workspace, meta.projectPath, workspaceId)
    return isRefusal(folder) ? undefined : folder.cwd
  }

  /** A stored check left non-terminal by an earlier launch: interrupted, and its PID never signalled. */
  const recover = (file: ResultFile): ResultFile => {
    const stale = file.checks.filter((c) => c.phase !== 'terminal' && !deps.checks.isLive(c.id))
    if (!stale.length) return file
    return deps.store.update(file.runId, file.threadId, (f) => ({
      ...f,
      checks: f.checks.map((c) => (stale.some((s) => s.id === c.id) && c.phase !== 'terminal'
        ? { ...c, phase: 'terminal', outcome: 'interrupted', reason: 'Cockpit quit while it ran; it was not resumed, and its process was not signalled afterwards.', endedAt: new Date().toISOString() }
        : c)),
    }))
  }

  async function view(meta: ThreadMeta, events: readonly StoredEvent[], runId: string, busy: boolean): Promise<ResultView> {
    const run = runsOf(meta.id, events).find((r) => r.runId === runId)
    if (!run) throw new UnknownRunError('That run is not in this conversation')
    const request = events[run.index]!
    const requestEvent = request.event.kind === 'user_text' ? request.event : undefined
    const end = events.slice(run.index + 1).find(({ event }) => event.kind === 'result' && (!event.runId || event.runId === runId))
    const endEvent = end?.event.kind === 'result' ? end.event : undefined
    const during = events.slice(run.index + 1, end ? events.indexOf(end) : undefined)
    const lastText = during.map((e) => e.event).filter((e) => e.kind === 'assistant_text').at(-1)
    const agentReport = endEvent?.text || (lastText?.kind === 'assistant_text' ? lastText.text : undefined)

    let file: ResultFile | undefined
    let recordError: string | undefined
    try {
      file = deps.store.get(runId)
      if (file && file.threadId !== meta.id) throw new UnknownRunError('That run is not in this conversation')
      if (file) file = recover(file)
    } catch (error) {
      if (!(error instanceof StoreReadError)) throw error
      recordError = error.message
    }

    const observation = deps.runs?.get(runId)
    const changes = runChanges(runId, observation, busy || Boolean(deps.observing?.(runId)))

    // Freshness: every finished check against the workspace as it is now. One observation, each check's own inputs.
    const records = [...(file?.checks ?? [])].sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
    let current: Observation | undefined
    const runWorkspace = requestEvent?.binding?.workspaceId ?? meta.workspaceId
    const folder = folderOf(meta, runWorkspace)
    if (folder && records.some((c) => c.subject)) {
      try { current = await look(folder) } catch { current = undefined }
    }
    const checks: CheckView[] = records.map((c) => {
      if (!c.subject || c.phase !== 'terminal') return c
      if (!current) return { ...c, freshness: { state: 'unknown', reasons: ['The workspace could not be read now.'] } }
      return { ...c, freshness: freshness(c.subject, fingerprintOf(folder!, current, c.definition.inputs)) }
    })

    const previews: PreviewView[] = (file?.evidence ?? []).filter((e) => e.kind === 'preview').map((e) => ({
      ...e, integrity: deps.store.readEvidence(runId, e).state, assessments: (file?.assessments ?? []).filter((a) => a.evidenceId === e.id),
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    const provider: ResultView['provider'] = run.ended ? { state: run.outcome ?? 'ok', ...(end ? { endedAt: end.ts } : {}) } : { state: 'working' }
    const gaps: string[] = []
    if (recordError) gaps.push(`The stored result could not be read: ${recordError}`)
    if (run.ended && run.outcome && run.outcome !== 'ok') gaps.push(`The agent did not finish normally (${run.outcome}).`)
    if (changes.state === 'unrecorded') gaps.push('No before/after record of the workspace for this run.')
    if (changes.state === 'incomplete') gaps.push('The workspace was observed before this run but not after it.')
    for (const reason of changes.comparison?.uncertain ?? []) gaps.push(`Changes uncertain: ${reason}`)
    if (!checks.length) gaps.push('No checks were run for this result.')
    // The newest check of each command speaks for it.
    const latest = new Map<string, CheckView>()
    for (const c of checks) if (!latest.has(c.definition.command)) latest.set(c.definition.command, c)
    for (const c of latest.values()) {
      const name = `“${c.definition.command}”`
      if (c.phase !== 'terminal') continue
      if (c.outcome !== 'passed') gaps.push(`${name} ${outcomeWord[c.outcome ?? 'error'] ?? c.outcome}.`)
      else if (c.freshness?.state === 'stale') gaps.push(`${name} passed against an earlier state of the workspace: ${c.freshness.reasons.join(' ')}`)
      else if (c.freshness?.state === 'unknown') gaps.push(`${name} passed, but whether that is still current is unknown: ${c.freshness.reasons.join('; ')}.`)
      if (c.output === undefined) gaps.push(`${name}: its output was not stored.`)
      else {
        const out = file?.evidence.find((e) => e.id === c.output!.evidenceId)
        const state = out ? deps.store.readEvidence(runId, out).state : 'missing'
        if (state !== 'ok') gaps.push(`${name}: its stored output is ${state}.`)
      }
    }
    for (const p of previews) {
      if (p.integrity !== 'ok') gaps.push(`A preview capture is ${p.integrity}; it was not replaced.`)
      else if (!p.assessments.length) gaps.push('A preview was captured but nobody has said whether it looks right.')
      else if (p.assessments.at(-1)!.verdict === 'looks-wrong') gaps.push('A preview was marked as looking wrong.')
    }

    return {
      version: RESULT_VERSION, runId, threadId: meta.id,
      identity: {
        projectPath: meta.projectPath, ...(runWorkspace ? { workspaceId: runWorkspace } : {}),
        bindingId: bindingAt(meta, events, run.index), agent: agentAt(meta, events, run.index),
        ...(meta.settings.model ? { model: meta.settings.model } : {}), account: 'default', profile: 'standard',
      },
      request: { eventIndex: run.index, ...(requestEvent?.operation?.id ? { operationId: requestEvent.operation.id } : {}), excerpt: (requestEvent?.text ?? '').slice(0, 200), at: request.ts },
      provider, complete: meta.completed, changes, checks, previews,
      ...(agentReport ? { agentReport: agentReport.slice(0, 2000) } : {}),
      gaps, ...(recordError ? { recordError } : {}), revision: file?.revision ?? 0,
      createdAt: file?.createdAt ?? request.ts,
      updatedAt: file?.updatedAt ?? end?.ts ?? request.ts,
    }
  }

  return {
    view,

    /** Captures the page at `url` for this run. The capture records what was seen, never that it is right. */
    async capture(meta: ThreadMeta, runId: string, url: string): Promise<EvidenceRecord> {
      if (!deps.capturePreview) throw new Error('Preview capture is only available in the Cockpit desktop app')
      deps.store.get(runId) // a damaged record refuses here, before anything is written
      const shot = await deps.capturePreview(url)
      let subjectDigest: string | undefined
      let head: string | null | undefined
      try {
        const folder = folderOf(meta, meta.workspaceId)
        if (!folder) throw new Error('This workspace no longer exists')
        const now = await look(folder)
        subjectDigest = fingerprintOf(folder, now, []).digest
        head = now.head
      } catch { /* recorded without a subject */ }
      const id = `ev-${randomUUID()}`
      const written = deps.store.writeEvidence(runId, id, 'png', Buffer.from(shot.data, 'base64'))
      const record: EvidenceRecord = {
        id, kind: 'preview', origin: 'host', file: written.file, mediaType: 'image/png', sha256: written.sha256, bytes: written.bytes, createdAt: new Date().toISOString(),
        preview: { url, viewport: { width: shot.width, height: shot.height }, ...(subjectDigest ? { subjectDigest } : {}), ...(head !== undefined ? { head } : {}) },
      }
      deps.store.update(runId, meta.id, (f) => ({ ...f, evidence: [...f.evidence, record] }))
      return record
    },

    /** A person's judgement of one capture, kept beside it. */
    assess(meta: ThreadMeta, runId: string, evidenceId: string, verdict: Assessment['verdict'], note?: string): Assessment {
      const file = deps.store.get(runId)
      if (!file || file.threadId !== meta.id || !file.evidence.some((e) => e.id === evidenceId && e.kind === 'preview')) throw new UnknownRunError('No such preview capture in this run')
      const assessment: Assessment = { id: `as-${randomUUID()}`, evidenceId, by: 'human', verdict, ...(note ? { note } : {}), at: new Date().toISOString() }
      deps.store.update(runId, meta.id, (f) => ({ ...f, assessments: [...f.assessments, assessment] }))
      return assessment
    },

    evidence(meta: ThreadMeta, runId: string, evidenceId: string) {
      const file = deps.store.get(runId)
      const record = file?.threadId === meta.id ? file.evidence.find((e) => e.id === evidenceId) : undefined
      if (!record) throw new UnknownRunError('No such evidence in this run')
      return { record, read: deps.store.readEvidence(runId, record) }
    },
  }
}

export type ResultService = ReturnType<typeof createResultService>
