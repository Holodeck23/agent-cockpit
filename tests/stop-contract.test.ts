import { describe, expect, it } from 'vitest'
import { parseInputBinding } from '../server/threads/input-envelope.ts'
import { observeStop, parseStopRecord, requestStop, StopContractError, STOP_ESCALATE_MS, STOP_REPORT_MS } from '../server/threads/stop-contract.ts'

const binding = parseInputBinding({ threadId: 'thread-one', projectId: 'project-one', workspaceId: 'worktree-one', bindingId: 'binding-one',
  provider: 'claude', providerVersion: 'fixture-one', runtimeRevision: 'runtime-one', adapterVersion: 'adapter-one',
  accountId: 'account-one', accountGeneration: 1, principalId: 'principal-one', credentialContextId: 'credential-one',
  nativeSessionId: 'session-one', launchGeneration: 1, manifestId: 'manifest-one', sourceRevision: 'source-one', authorizationRevision: 'consent-one' })
const input = { binding, runId: 'run-one', requestId: '7b0f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f' }
const start = 10_000
const begin = () => requestStop(input, start)
const verified = () => ({ type: 'retirement-verified' as const, binding, runId: input.runId,
  receiptId: 'host-retirement-receipt', providerRetired: true as const, ownedDescendantsQuiescent: true as const })

describe('bounded host Stop contract', () => {
  it('fences immediately and revokes grants/approvals before native cancellation', () => {
    const stop = begin()
    expect(stop.record.dispatchBlocked).toBe(true)
    expect(stop.effects).toEqual(['revoke-grants', 'cancel-approvals', 'classify-queued-input', 'persist-stop', 'request-native-cancel'])
    expect(Object.isFrozen(stop.record.binding)).toBe(true)
  })

  it('escalates once at 1.5 seconds and reports uncertainty by five seconds', () => {
    let stop = begin()
    stop = observeStop(stop.record, { type: 'tick' }, start + STOP_ESCALATE_MS - 1)
    expect(stop.effects).not.toContain('retire-owned-provider')
    stop = observeStop(stop.record, { type: 'tick' }, start + STOP_ESCALATE_MS)
    expect(stop.effects).toContain('retire-owned-provider')
    stop = observeStop(stop.record, { type: 'tick' }, start + STOP_ESCALATE_MS + 1)
    expect(stop.effects).not.toContain('retire-owned-provider')
    stop = observeStop(stop.record, { type: 'tick' }, start + STOP_REPORT_MS)
    expect(stop).toMatchObject({ record: { outcome: 'uncertain', reason: 'deadline', dispatchBlocked: true } })
    expect(stop.effects).toEqual(['persist-stop', 'report-uncertain'])
  })

  it('does not mistake a native acknowledgment for verified termination', () => {
    const ack = observeStop(begin().record, { type: 'native-ack', binding, runId: input.runId }, start + 100)
    expect(ack.record.outcome).toBe('waiting')
    expect(observeStop(ack.record, { type: 'tick' }, start + STOP_ESCALATE_MS).effects).not.toContain('retire-owned-provider')
    const deadline = observeStop(ack.record, { type: 'tick' }, start + STOP_REPORT_MS)
    expect(deadline.record.outcome).toBe('uncertain')
    expect(deadline.effects).toContain('retire-owned-provider')
  })

  it('persists host retirement proof before reporting verified and keeps the old run fenced', () => {
    const observed = observeStop(begin().record, verified(), start + 200)
    expect(observed.record.outcome).toBe('waiting')
    expect(observed.effects).not.toContain('report-verified')
    const stop = observeStop(observed.record, { type: 'record-persisted', requestId: input.requestId, retirementReceiptId: verified().receiptId }, start + 201)
    expect(stop.record).toMatchObject({ outcome: 'verified', dispatchBlocked: true, verification: { receiptId: 'host-retirement-receipt' } })
    expect(stop.effects).toEqual(['report-verified'])
    expect(observeStop(stop.record, { type: 'native-ack', binding, runId: input.runId }, start + 300).effects).toEqual([])
  })

  it.each(Object.keys(binding))('does not trust retirement proof or acknowledgment from a different %s', (field) => {
    const other = parseInputBinding({ ...binding, [field]: typeof binding[field as keyof typeof binding] === 'number' ? 2 : field === 'provider' ? 'codex' : 'other' })
    const stop = observeStop(begin().record, { ...verified(), binding: other }, start + 100)
    expect(stop.record.outcome).toBe('waiting')
    expect(observeStop(stop.record, { type: 'native-ack', binding: other, runId: input.runId }, start + 200).record.nativeAcknowledged).toBe(false)
  })

  it('does not accept another run or unverified owned descendants', () => {
    expect(observeStop(begin().record, { ...verified(), runId: 'other-run' }, start + 100).record.outcome).toBe('waiting')
    expect(() => observeStop(begin().record, { ...verified(), ownedDescendantsQuiescent: false } as unknown as ReturnType<typeof verified>, start + 100)).toThrow(StopContractError)
  })

  it('cannot reset its original deadline on another Stop click or JSON restart recovery', () => {
    const original = begin().record
    const again = requestStop({ ...input, requestId: '8b0f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f' }, start + 4_000, original)
    expect(again.record.requestedAtMs).toBe(start)
    expect(again.effects).not.toContain('request-native-cancel')
    expect(again.effects).toContain('retire-owned-provider')
    const restored = parseStopRecord(JSON.parse(JSON.stringify(again.record)))
    expect(observeStop(restored, { type: 'tick' }, start + STOP_REPORT_MS).record.outcome).toBe('uncertain')
  })

  it('keeps late acknowledgments/retirement proof from reopening an uncertain run', () => {
    const deadline = observeStop(begin().record, { type: 'tick' }, start + STOP_REPORT_MS)
    for (const observation of [verified(), { type: 'native-ack' as const, binding, runId: input.runId }]) {
      expect(observeStop(deadline.record, observation, start + 6_000)).toEqual({ record: deadline.record, effects: [] })
    }
    expect(observeStop(begin().record, verified(), start + STOP_REPORT_MS).record.outcome).toBe('uncertain')
  })

  it('fails closed on clock rollback and does not undo an escalation after a late ack', () => {
    const tick = observeStop(begin().record, { type: 'tick' }, start + 100)
    expect(observeStop(tick.record, { type: 'tick' }, start + 50).record).toMatchObject({ outcome: 'uncertain', reason: 'clock-anomaly' })
    const late = observeStop(begin().record, { type: 'native-ack', binding, runId: input.runId }, start + 2_000)
    expect(late.record.nativeAcknowledged).toBe(true)
    expect(late.effects).toContain('retire-owned-provider')
  })

  it('keeps dispatch blocked and aborts success reporting when persistence fails', () => {
    const logicalSuccess = observeStop(begin().record, verified(), start + 200)
    expect(observeStop(logicalSuccess.record, { type: 'durability-failed' }, start + 201)).toMatchObject({
      record: { outcome: 'uncertain', reason: 'durability-failed', dispatchBlocked: true }, effects: ['report-uncertain'],
    })
  })

  it('does not report verified for a hung write, a stale write acknowledgement or a different receipt', () => {
    const pending = observeStop(begin().record, verified(), start + 200)
    const wrongRequest = observeStop(pending.record, { type: 'record-persisted', requestId: 'different', retirementReceiptId: verified().receiptId }, start + 201)
    expect(wrongRequest.record.barrierPersisted).toBe(false)
    const barrierOnly = observeStop(wrongRequest.record, { type: 'record-persisted', requestId: input.requestId, retirementReceiptId: 'old-receipt' }, start + 202)
    expect(barrierOnly.record.outcome).toBe('waiting')
    expect(barrierOnly.record.retirementPersisted).toBe(false)
    expect(barrierOnly.effects).toEqual([])
    const deadline = observeStop(barrierOnly.record, { type: 'tick' }, start + STOP_REPORT_MS)
    expect(deadline.record.outcome).toBe('uncertain')
    expect(deadline.effects).toContain('report-uncertain')
    expect(observeStop(deadline.record, { type: 'record-persisted', requestId: input.requestId, retirementReceiptId: verified().receiptId }, start + STOP_REPORT_MS + 1).record.outcome).toBe('uncertain')
  })

  it('rejects corrupt records/unknown observations without treating model text as a host oracle', () => {
    expect(() => parseStopRecord({ ...begin().record, dispatchBlocked: false })).toThrow(StopContractError)
    expect(() => parseStopRecord({ ...begin().record, outcome: 'verified' })).toThrow(StopContractError)
    expect(() => parseStopRecord({ ...begin().record, outcome: 'uncertain' })).toThrow(StopContractError)
    expect(() => requestStop({ ...input, runId: 'other' }, start, begin().record)).toThrow(StopContractError)
    expect(() => observeStop(begin().record, { type: 'assistant', text: 'stopped' } as any, start + 1)).toThrow(StopContractError)
    expect(() => observeStop(begin().record, { type: 'tick' }, NaN)).toThrow(StopContractError)
  })
})
