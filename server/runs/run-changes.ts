import { compareObservations, type Observation, type RunComparison } from '../git/observe.ts'
import type { RunObservation } from './observations.ts'

// A run's Changes view (W7-05): its two observations compared, with every reason the comparison
// cannot be read as exact. It reports what changed in the folder during the run, never who did it.

/** What one run's before/after observations show, for its Changes view (W7-05). */
export interface RunChanges {
  /** incomplete: started but never observed after (Cockpit stopped, or the read failed). */
  readonly state: 'unrecorded' | 'running' | 'incomplete' | 'recorded'
  readonly runId: string
  readonly before?: { readonly observedAt: string; readonly head: string | null; readonly branch: string | null; readonly repo: boolean }
  readonly after?: { readonly observedAt: string; readonly head: string | null; readonly branch: string | null; readonly repo: boolean }
  readonly comparison?: RunComparison
  /** Already changed when the run started: shown as such, never as the run's work. */
  readonly preexisting: number
  readonly concurrent: readonly string[]
}

/** `inProgress`: the run is still working, or its observation is still being taken. */
export function runChanges(runId: string, record: RunObservation | undefined, inProgress: boolean): RunChanges {
  const head = (o: Observation) => ({ observedAt: o.observedAt, head: o.head, branch: o.branch, repo: o.repo })
  if (!record?.before) return { state: inProgress ? 'running' : 'unrecorded', runId, preexisting: 0, concurrent: [] }
  const base = { runId, before: head(record.before), preexisting: record.before.files.length, concurrent: record.concurrent ?? [] }
  if (!record.after) return { ...base, state: inProgress ? 'running' : 'incomplete' }
  const comparison = compareObservations(record.before, record.after)
  const uncertain = [
    ...(record.lateBefore ? ['The agent had started before the “before” snapshot finished.'] : []),
    ...(record.concurrent?.length ? [`Other conversations were working in this folder: ${record.concurrent.join(', ')}.`] : []),
    ...comparison.uncertain,
  ]
  return { ...base, state: 'recorded', after: head(record.after), comparison: { ...comparison, uncertain } }
}
