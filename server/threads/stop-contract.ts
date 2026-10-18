// Domino 2 Stop substate for later integration into the existing thread/run manager.
// Pure: no timers, process signals, persistence, callbacks or dispatch are performed here.
import { z } from 'zod'
import { parseInputBinding, type InputBinding } from './input-envelope.ts'

export const STOP_ESCALATE_MS = 1_500
export const STOP_REPORT_MS = 5_000
const id = z.string().min(1).max(300).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - STOP_REPORT_MS)
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), requestId: z.uuid(), runId: id, binding: z.unknown(),
  requestedAtMs: time, lastObservedAtMs: time,
  dispatchBlocked: z.literal(true), nativeAcknowledged: z.boolean(), escalationRequested: z.boolean(),
  barrierPersisted: z.boolean(), retirementPersisted: z.boolean(),
  outcome: z.enum(['waiting', 'verified', 'uncertain']),
  reason: z.enum(['deadline', 'clock-anomaly', 'durability-failed']).optional(),
  verification: z.strictObject({ receiptId: id, observedAtMs: time }).readonly().optional(),
}).refine((record) => record.lastObservedAtMs >= record.requestedAtMs
  && (record.outcome === 'uncertain' ? record.reason !== undefined : record.reason === undefined)
  && (!record.retirementPersisted || (record.barrierPersisted && record.verification !== undefined))
  && (record.outcome !== 'verified' || (record.barrierPersisted && record.retirementPersisted && record.verification !== undefined
    && record.verification.observedAtMs >= record.requestedAtMs
    && record.verification.observedAtMs < record.requestedAtMs + STOP_REPORT_MS
    && record.verification.observedAtMs <= record.lastObservedAtMs)))

export type StopRecord = Readonly<Omit<z.output<typeof recordSchema>, 'binding'> & { readonly binding: InputBinding }>
export type StopEffect = 'revoke-grants' | 'cancel-approvals' | 'classify-queued-input' | 'persist-stop'
  | 'request-native-cancel' | 'retire-owned-provider' | 'report-verified' | 'report-uncertain'
export interface StopTransition { readonly record: StopRecord; readonly effects: readonly StopEffect[] }
export type StopObservation =
  | { readonly type: 'tick' }
  | { readonly type: 'durability-failed' }
  | { readonly type: 'record-persisted'; readonly requestId: string; readonly retirementReceiptId?: string }
  | { readonly type: 'native-ack'; readonly binding: InputBinding; readonly runId: string }
  | { readonly type: 'retirement-verified'; readonly binding: InputBinding; readonly runId: string;
      readonly receiptId: string; readonly providerRetired: true; readonly ownedDescendantsQuiescent: true }

export class StopContractError extends Error { constructor() { super('Stop contract identity or state is invalid') } }

export function parseStopRecord(raw: unknown): StopRecord {
  const parsed = recordSchema.safeParse(raw)
  if (!parsed.success) throw new StopContractError()
  try { return Object.freeze({ ...parsed.data, binding: parseInputBinding(parsed.data.binding) }) }
  catch { throw new StopContractError() }
}

const transition = (record: StopRecord, effects: readonly StopEffect[]): StopTransition =>
  Object.freeze({ record: parseStopRecord(record), effects: Object.freeze([...effects]) })
const sameBinding = (left: InputBinding, right: InputBinding): boolean => {
  try { return JSON.stringify(parseInputBinding(left)) === JSON.stringify(parseInputBinding(right)) }
  catch { return false }
}

/**
 * Set the barrier and invalidate grants/approvals synchronously. Native cancellation/retirement
 * must run while persistence is pending, not await a slow disk. Repeated Stop keeps its deadline.
 */
export function requestStop(input: { readonly binding: InputBinding; readonly runId: string; readonly requestId: string },
  nowMs: number, existing?: StopRecord): StopTransition {
  const binding = parseInputBinding(input.binding)
  if (!time.safeParse(nowMs).success || !id.safeParse(input.runId).success || !z.uuid().safeParse(input.requestId).success) throw new StopContractError()
  if (existing) {
    const record = parseStopRecord(existing)
    if (record.runId !== input.runId || !sameBinding(record.binding, binding)) throw new StopContractError()
    return observeStop(record, { type: 'tick' }, nowMs)
  }
  return transition({ schemaVersion: 1, requestId: input.requestId, runId: input.runId, binding,
    requestedAtMs: nowMs, lastObservedAtMs: nowMs, dispatchBlocked: true,
    nativeAcknowledged: false, escalationRequested: false, barrierPersisted: false, retirementPersisted: false, outcome: 'waiting' },
  ['revoke-grants', 'cancel-approvals', 'classify-queued-input', 'persist-stop', 'request-native-cancel'])
}

/**
 * Observations are host-owned and tagged with the original immutable run binding. A native ack
 * alone is not retirement proof. Model text and ordinary provider results never supply a verified event.
 * A verified report requires the barrier and exact retirement receipt to have been persisted.
 * Uncertainty is reported by the deadline even if persistence is still pending or failed.
 */
export function observeStop(raw: StopRecord, observation: StopObservation, nowMs: number): StopTransition {
  const prior = parseStopRecord(raw)
  if (!time.safeParse(nowMs).success) throw new StopContractError()
  if (!observation || !['tick', 'durability-failed', 'record-persisted', 'native-ack', 'retirement-verified'].includes(observation.type)) throw new StopContractError()
  if (observation.type === 'durability-failed') {
    return transition({ ...prior, outcome: 'uncertain', reason: 'durability-failed' }, ['report-uncertain'])
  }
  // A late native callback, result or clock tick cannot undo either terminal outcome or the barrier.
  if (prior.outcome !== 'waiting') return transition(prior, [])
  const effects: StopEffect[] = []
  let record: StopRecord = { ...prior, lastObservedAtMs: Math.max(nowMs, prior.lastObservedAtMs) }
  const escalate = (): void => {
    if (!record.escalationRequested && !record.verification) {
      record = { ...record, escalationRequested: true }
      effects.push('retire-owned-provider')
    }
  }
  // A rollback is uncertainty immediately; saved wall-clock deadlines are never restarted on recovery.
  if (nowMs < prior.lastObservedAtMs || nowMs >= prior.requestedAtMs + STOP_REPORT_MS) {
    escalate()
    record = { ...record, outcome: 'uncertain', reason: nowMs < prior.lastObservedAtMs ? 'clock-anomaly' : 'deadline' }
    return transition(record, ['persist-stop', ...effects, 'report-uncertain'])
  }
  if (!prior.nativeAcknowledged && nowMs >= prior.requestedAtMs + STOP_ESCALATE_MS) escalate()
  if (observation.type === 'record-persisted' && observation.requestId === prior.requestId) {
    const retirementPersisted = prior.verification !== undefined && observation.retirementReceiptId === prior.verification.receiptId
    record = { ...record, barrierPersisted: true, retirementPersisted: prior.retirementPersisted || retirementPersisted }
    if (record.retirementPersisted) return transition({ ...record, outcome: 'verified' }, [...effects, 'report-verified'])
    return transition(record, effects)
  }
  if (observation.type === 'native-ack' || observation.type === 'retirement-verified') {
    // Unrelated observations cannot acknowledge this Stop; time still advances to enforce its deadline.
    if (observation.runId === prior.runId && sameBinding(observation.binding, prior.binding)) {
      if (observation.type === 'native-ack') record = { ...record, nativeAcknowledged: true }
      else {
        if (observation.providerRetired !== true || observation.ownedDescendantsQuiescent !== true || !id.safeParse(observation.receiptId).success) throw new StopContractError()
        if (prior.verification) {
          // Do not let a duplicated/different receipt replace the immutable proof being persisted.
          if (prior.verification.receiptId !== observation.receiptId) throw new StopContractError()
        } else record = { ...record, verification: Object.freeze({ receiptId: observation.receiptId, observedAtMs: nowMs }) }
        return transition(record, ['persist-stop', ...effects])
      }
    }
  }
  return transition(record, ['persist-stop', ...effects])
}
