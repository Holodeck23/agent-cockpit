import { describe, expect, it } from 'vitest'
import { parseInputBinding } from '../server/threads/input-envelope.ts'
import { acknowledgeCompletionPersistence as persist, beginCompletionCycle as begin, completionDisposition as disposition,
  createCompletionLedger, fenceCompletionLedger as fence, observeCompletionHook as observe,
  parseCompletionLedger, CompletionContractError, type CompletionLedger } from '../server/threads/completion-ledger.ts'

const binding = parseInputBinding({ threadId: 'thread', projectId: 'project', workspaceId: 'workspace', bindingId: 'binding',
  provider: 'codex', providerVersion: 'fixture', runtimeRevision: 'runtime', adapterVersion: 'adapter',
  accountId: 'account', accountGeneration: 1, principalId: 'principal', credentialContextId: 'credential',
  nativeSessionId: 'session', launchGeneration: 1, manifestId: 'manifest', sourceRevision: 'source', authorizationRevision: 'consent' })
const parent = { kind: 'parent' as const }, agent = { kind: 'subagent' as const, agentId: 'worker' }
const fresh = (): CompletionLedger => createCompletionLedger({ binding, runId: 'run', nativeSessionId: 'session' })
const input = (cycleId = 'cycle-one', target: typeof parent | typeof agent = parent, nativeTurnId = 'turn') => ({ binding,
  runId: 'run', nativeSessionId: 'session', cycleId, target, nativeTurnId, identitySource: 'provider-cycle' as const,
  hooks: [{ id: 'a', revision: 'rev-a', role: 'completion' as const }, { id: 'b', revision: 'rev-b', role: 'completion' as const }] })
const event = (hookId = 'a', outcome: 'allow' | 'reject' | 'error' | 'timeout' = 'allow', receiptId = `receipt-${hookId}`) => ({ receiptId,
  hookId, hookRevision: `rev-${hookId}`, outcome })
const finish = (state: CompletionLedger, cycleId: string, reject = false): CompletionLedger =>
  observe(observe(state, cycleId, event('b', 'allow', `${cycleId}-b`)), cycleId, event('a', reject ? 'reject' : 'allow', `${cycleId}-a`))
const durable = (state: CompletionLedger): CompletionLedger => persist(state, state.revision)

describe('host completion ledger shared contract', () => {
  it('waits for every policy callback and durability before allowing completion', () => {
    const begun = begin(fresh(), input())
    expect(disposition(begun, 'turn', parent)).toBe('hold')
    const first = observe(begun, 'cycle-one', event())
    expect(disposition(durable(first), 'turn', parent)).toBe('hold')
    const done = observe(first, 'cycle-one', event('b'))
    expect(disposition(done, 'turn', parent)).toBe('hold')
    expect(disposition(durable(done), 'turn', parent)).toBe('complete')
  })
  it('groups two rejecting hooks as one correction and refuses a third cycle after restart', () => {
    let state = begin(fresh(), input())
    state = observe(observe(state, 'cycle-one', event('a', 'reject')), 'cycle-one', event('b', 'reject'))
    expect(disposition(durable(state), 'turn', parent)).toBe('one-correction')
    state = parseCompletionLedger(JSON.parse(JSON.stringify(durable(state))))
    state = finish(begin(state, input('cycle-two')), 'cycle-two', true)
    expect(disposition(state, 'turn', parent)).toBe('block')
    expect(disposition(durable(state), 'turn', agent)).toBe('block')
    expect(() => begin(durable(state), input('cycle-three', parent, 'new-turn'))).toThrow(CompletionContractError)
  })
  it('permits an accepted correction only after its own persistence', () => {
    const first = durable(finish(begin(fresh(), input()), 'cycle-one', true))
    const second = finish(begin(first, input('cycle-two')), 'cycle-two')
    expect(disposition(second, 'turn', parent)).toBe('hold')
    expect(disposition(durable(second), 'turn', parent)).toBe('complete')
  })
  it('deduplicates callbacks and begins across restart without increasing rejection count', () => {
    const original = observe(begin(fresh(), input()), 'cycle-one', event('a', 'reject'))
    const restored = parseCompletionLedger(JSON.parse(JSON.stringify(original)))
    expect(observe(restored, 'cycle-one', event('a', 'reject'))).toEqual(original)
    expect(begin(restored, input())).toEqual(original)
    expect(() => observe(restored, 'cycle-one', event('a', 'allow'))).toThrow()
    expect(() => observe(restored, 'cycle-one', event('a', 'reject', 'new-receipt'))).toThrow()
  })
  it.each(['policy', 'unknown'] as const)('blocks %s rejection immediately without correction', (role) => {
    const state = begin(fresh(), { ...input(), hooks: [{ id: 'a', revision: 'rev-a', role }] })
    expect(disposition(observe(state, 'cycle-one', event('a', 'reject')), 'turn', parent)).toBe('block')
  })
  it.each(['completion', 'policy', 'unknown'] as const)('blocks timeout and internal failure of %s', (role) => {
    for (const outcome of ['timeout', 'error'] as const) {
      const state = begin(fresh(), { ...input(), hooks: [{ id: 'a', revision: 'rev-a', role }] })
      expect(disposition(observe(state, 'cycle-one', event('a', outcome)), 'turn', parent)).toBe('block')
    }
  })
  it.each(['reject', 'timeout', 'error'] as const)('retains enrichment %s visibly while permitting durable completion', (outcome) => {
    const state = begin(fresh(), { ...input(), hooks: [{ id: 'a', revision: 'rev-a', role: 'enrichment' }] })
    const done = observe(state, 'cycle-one', event('a', outcome))
    expect(done.cycles[0]!.observations[0]!.outcome).toBe(outcome)
    expect(disposition(durable(done), 'turn', parent)).toBe('complete')
  })
  it('keeps parent and agent correction budgets distinct but blocks global completion while a batch is pending', () => {
    const first = durable(finish(begin(fresh(), input()), 'cycle-one', true))
    const child = begin(first, input('child-cycle', agent))
    expect(disposition(child, 'turn', parent)).toBe('hold')
    const childDone = durable(finish(child, 'child-cycle'))
    expect(disposition(childDone, 'turn', agent)).toBe('complete')
    expect(disposition(childDone, 'turn', parent)).toBe('one-correction')
  })
  it.each(Object.keys(binding))('rejects new cycles with a changed %s binding', (field) => {
    const other = parseInputBinding({ ...binding, [field]: typeof binding[field as keyof typeof binding] === 'number' ? 2 : field === 'provider' ? 'claude' : 'other' })
    expect(() => begin(fresh(), { ...input(), binding: other })).toThrow()
  })
  it('rejects stale native session/run and conflicting hook revisions', () => {
    for (const changed of [{ nativeSessionId: 'other' }, { runId: 'other' }]) expect(() => begin(fresh(), { ...input(), ...changed })).toThrow()
    const state = begin(fresh(), input())
    expect(() => observe(state, 'cycle-one', { ...event(), hookRevision: 'changed' })).toThrow()
    expect(() => begin(state, { ...input(), identitySource: 'host-batch' })).toThrow()
    expect(() => observe(state, 'unknown-cycle', event())).toThrow()
  })
  it('cannot release a new batch or correction based on an old persistence acknowledgment', () => {
    const state = finish(begin(fresh(), input()), 'cycle-one', true)
    const stale = persist(state, state.revision - 1)
    expect(disposition(stale, 'turn', parent)).toBe('hold')
    expect(() => begin(stale, input('cycle-two'))).toThrow()
    expect(() => begin(begin(fresh(), input()), input('parallel'))).toThrow()
  })
  it.each(['stop', 'durability-failed'] as const)('keeps %s fenced through late callbacks and persistence', (reason) => {
    const state = fence(begin(fresh(), input()), reason)
    expect(disposition(durable(state), 'turn', parent)).toBe('block')
    expect(() => observe(state, 'cycle-one', event())).toThrow()
    expect(() => begin(durable(state), input('new'))).toThrow()
  })
  it('rejects malformed recovery records rather than trusting a saved success', () => {
    const state = finish(begin(fresh(), input()), 'cycle-one')
    for (const change of [{ persistedRevision: state.revision + 1 }, { cycles: [...state.cycles, state.cycles[0]] },
      { cycles: [{ ...state.cycles[0], observations: [], result: 'allow' }] }]) expect(() => parseCompletionLedger({ ...state, ...change })).toThrow()
    expect(() => begin(fresh(), { ...input(), identitySource: 'assistant-text' } as any)).toThrow()
  })
  it('freezes persisted evidence and does not mutate the caller data', () => {
    const requested = input(), state = begin(fresh(), requested)
    requested.hooks[0]!.revision = 'later-change'
    expect(state.cycles[0]!.hooks[0]!.revision).toBe('rev-a')
    expect(Object.isFrozen(state.cycles[0]!.hooks[0])).toBe(true)
    expect(Object.isFrozen(state.cycles[0]!.target)).toBe(true)
  })
  it('rejects a correction that changes the reviewed hook list or identity mechanism', () => {
    const first = durable(finish(begin(fresh(), input()), 'cycle-one', true))
    expect(() => begin(first, { ...input('cycle-two'), hooks: [{ id: 'a', revision: 'rev-a', role: 'completion' }] })).toThrow()
    expect(() => begin(first, { ...input('cycle-two'), identitySource: 'host-batch' })).toThrow()
  })
  it('rejects recovery that places a new cycle after a pending or blocked batch', () => {
    const pending = begin(fresh(), input())
    const later = { ...pending.cycles[0], cycleId: 'later' }
    expect(() => parseCompletionLedger({ ...pending, cycles: [...pending.cycles, later] })).toThrow()
    const blocked = observe(pending, 'cycle-one', event('a', 'error'))
    expect(() => parseCompletionLedger({ ...blocked, cycles: [...blocked.cycles, later] })).toThrow()
  })
  it('refuses a native session inconsistent with the immutable binding', () => {
    expect(() => createCompletionLedger({ binding, runId: 'run', nativeSessionId: 'foreign' })).toThrow()
  })
})
