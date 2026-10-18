// Pure host-owned completion contract. Native observation authentication and disk I/O are adapter work.
import { z } from 'zod'
import { parseInputBinding, type InputBinding } from './input-envelope.ts'

const id = z.string().min(1).max(300).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
const role = z.enum(['policy', 'completion', 'enrichment', 'unknown'])
const hook = z.strictObject({ id, revision: id, role }).readonly()
const target = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('parent') }),
  z.strictObject({ kind: z.literal('subagent'), agentId: id })])
const observation = z.strictObject({ receiptId: id, hookId: id, hookRevision: id,
  outcome: z.enum(['allow', 'reject', 'error', 'timeout']), }).readonly()
const cycle = z.strictObject({ cycleId: id, nativeTurnId: id, target,
  identitySource: z.enum(['provider-cycle', 'host-batch']), hooks: z.array(hook).min(1).max(100),
  observations: z.array(observation).max(100), result: z.enum(['pending', 'allow', 'reject', 'block']) })
const ledger = z.strictObject({ schemaVersion: z.literal(1), binding: z.unknown(), runId: id, nativeSessionId: id,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  persistedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  cycles: z.array(cycle).max(1000), stopped: z.boolean(), durabilityFailed: z.boolean() })

type Cycle = z.output<typeof cycle>
type Target = z.output<typeof target>
type ImmutableCycle = Readonly<Omit<Cycle, 'hooks' | 'observations' | 'target'> & {
  readonly hooks: readonly z.output<typeof hook>[];
  readonly observations: readonly z.output<typeof observation>[];
  readonly target: Readonly<Target>;
}>
export type CompletionLedger = Readonly<Omit<z.output<typeof ledger>, 'binding' | 'cycles'> & {
  readonly binding: InputBinding; readonly cycles: readonly ImmutableCycle[]
}>
export class CompletionContractError extends Error { constructor() { super('Completion ledger identity or state is invalid') } }
const key = (value: Target): string => value.kind === 'parent' ? 'parent' : `subagent:${value.agentId}`
const scopeKey = (value: ImmutableCycle): string => JSON.stringify([key(value.target), value.nativeTurnId])
const exhausted = (cycles: readonly ImmutableCycle[]): boolean => {
  const rejections = new Map<string, number>()
  for (const value of cycles) if (value.result === 'reject') {
    const count = (rejections.get(scopeKey(value)) ?? 0) + 1
    if (count === 2) return true
    rejections.set(scopeKey(value), count)
  }
  return false
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const aggregate = (value: Cycle): Cycle['result'] => {
  if (value.observations.some((entry) => {
    const owner = value.hooks.find((candidate) => candidate.id === entry.hookId)!
    return owner.role !== 'enrichment' && (entry.outcome === 'error' || entry.outcome === 'timeout'
      || entry.outcome === 'reject' && owner.role !== 'completion')
  })) return 'block'
  if (value.observations.length !== value.hooks.length) return 'pending'
  return value.observations.some((entry) => entry.outcome === 'reject'
    && value.hooks.find((candidate) => candidate.id === entry.hookId)!.role !== 'enrichment') ? 'reject' : 'allow'
}

/** Restored state is validated structurally; only the host persistence layer supplies acknowledgments. */
export function parseCompletionLedger(raw: unknown): CompletionLedger {
  try {
    const parsed = ledger.parse(raw), binding = parseInputBinding(parsed.binding)
    if (parsed.persistedRevision > parsed.revision || binding.nativeSessionId !== parsed.nativeSessionId) throw new Error()
    const ids = new Set<string>(), receipts = new Set<string>(), counts = new Map<string, number>()
    const earlier: Cycle[] = []
    for (const value of parsed.cycles) {
      if (earlier.some((entry) => entry.result === 'pending' || entry.result === 'block') || exhausted(earlier)) throw new Error()
      if (ids.has(value.cycleId)) throw new Error()
      ids.add(value.cycleId)
      const hookIds = new Set(value.hooks.map((entry) => entry.id))
      if (hookIds.size !== value.hooks.length) throw new Error()
      const seen = new Set<string>()
      for (const entry of value.observations) {
        if (receipts.has(entry.receiptId) || seen.has(entry.hookId)
          || !value.hooks.some((owner) => owner.id === entry.hookId && owner.revision === entry.hookRevision)) throw new Error()
        receipts.add(entry.receiptId); seen.add(entry.hookId)
      }
      if (aggregate(value) !== value.result) throw new Error()
      const scope = scopeKey(value)
      const prior = earlier.filter((candidate) => key(candidate.target) === key(value.target) && candidate.nativeTurnId === value.nativeTurnId)
      const count = (counts.get(scope) ?? 0) + 1
      if (count > 2 || count === 2 && (prior[0]?.result !== 'reject'
        || !equal(prior[0].hooks, value.hooks) || prior[0].identitySource !== value.identitySource)) throw new Error()
      counts.set(scope, count)
      earlier.push(value)
      Object.freeze(value.target)
      Object.freeze(value.hooks); Object.freeze(value.observations); Object.freeze(value)
    }
    return Object.freeze({ ...parsed, binding, cycles: Object.freeze(parsed.cycles) })
  } catch { throw new CompletionContractError() }
}

export function createCompletionLedger(input: { binding: InputBinding; runId: string; nativeSessionId: string }): CompletionLedger {
  return parseCompletionLedger({ schemaVersion: 1, ...input, revision: 0, persistedRevision: 0,
    cycles: [], stopped: false, durabilityFailed: false })
}

const revise = (prior: CompletionLedger, changes: Partial<CompletionLedger>): CompletionLedger =>
  parseCompletionLedger({ ...prior, ...changes, revision: prior.revision + 1 })

/** Never construct from assistant text or per-handler run IDs. Authenticate the native run/batch first. */
export function beginCompletionCycle(raw: CompletionLedger, input: { binding: InputBinding; runId: string; nativeSessionId: string;
  cycleId: string; nativeTurnId: string; target: Target; identitySource: 'provider-cycle' | 'host-batch';
  hooks: readonly { id: string; revision: string; role: z.output<typeof role> }[] }): CompletionLedger {
  const prior = parseCompletionLedger(raw)
  if (!equal(parseInputBinding(input.binding), prior.binding) || input.runId !== prior.runId
    || input.nativeSessionId !== prior.nativeSessionId) throw new CompletionContractError()
  const proposed = cycle.safeParse({ cycleId: input.cycleId, nativeTurnId: input.nativeTurnId,
    target: input.target, identitySource: input.identitySource, hooks: input.hooks, observations: [], result: 'pending' })
  if (!proposed.success) throw new CompletionContractError()
  const existing = prior.cycles.find((entry) => entry.cycleId === input.cycleId)
  if (existing) {
    if (!equal({ ...existing, observations: [], result: 'pending' }, proposed.data)) throw new CompletionContractError()
    return prior
  }
  if (prior.stopped || prior.durabilityFailed || prior.revision !== prior.persistedRevision
    || exhausted(prior.cycles) || prior.cycles.some((entry) => entry.result === 'pending' || entry.result === 'block')) throw new CompletionContractError()
  const siblings = prior.cycles.filter((entry) => key(entry.target) === key(input.target) && entry.nativeTurnId === input.nativeTurnId)
  if (siblings.length >= 2 || siblings.length === 1 && siblings[0]!.result !== 'reject') throw new CompletionContractError()
  return revise(prior, { cycles: [...prior.cycles, proposed.data] })
}

/** An authenticated batch receipt is immutable: exact duplicate is inert; conflicting replay blocks via error. */
export function observeCompletionHook(raw: CompletionLedger, cycleId: string, input: z.output<typeof observation>): CompletionLedger {
  const prior = parseCompletionLedger(raw)
  const parsed = observation.safeParse(input)
  if (!parsed.success) throw new CompletionContractError()
  const duplicate = prior.cycles.flatMap((entry) => entry.observations.map((receipt) => ({ cycleId: entry.cycleId, receipt })))
    .find((entry) => entry.receipt.receiptId === input.receiptId)
  if (duplicate) {
    if (duplicate.cycleId !== cycleId || !equal(duplicate.receipt, parsed.data)) throw new CompletionContractError()
    return prior
  }
  const current = prior.cycles.find((entry) => entry.cycleId === cycleId)
  if (!current || current.result !== 'pending' || prior.stopped || prior.durabilityFailed
    || !current.hooks.some((entry) => entry.id === input.hookId && entry.revision === input.hookRevision)
    || current.observations.some((entry) => entry.hookId === input.hookId)) throw new CompletionContractError()
  const changed = cycle.parse({ ...current, observations: [...current.observations, parsed.data] })
  changed.result = aggregate(changed)
  return revise(prior, { cycles: prior.cycles.map((entry) => entry === current ? changed : entry) })
}

export function acknowledgeCompletionPersistence(raw: CompletionLedger, revision: number): CompletionLedger {
  const prior = parseCompletionLedger(raw)
  if (revision !== prior.revision) return prior
  return parseCompletionLedger({ ...prior, persistedRevision: revision })
}

export function fenceCompletionLedger(raw: CompletionLedger, reason: 'stop' | 'durability-failed'): CompletionLedger {
  const prior = parseCompletionLedger(raw)
  if (reason !== 'stop' && reason !== 'durability-failed') throw new CompletionContractError()
  if (prior.stopped && reason === 'stop' || prior.durabilityFailed && reason === 'durability-failed') return prior
  return revise(prior, reason === 'stop' ? { stopped: true } : { durabilityFailed: true })
}

export function completionDisposition(raw: CompletionLedger, nativeTurnId: string, subject: Target):
  'hold' | 'complete' | 'one-correction' | 'block' {
  const prior = parseCompletionLedger(raw)
  if (prior.stopped || prior.durabilityFailed || exhausted(prior.cycles) || prior.cycles.some((entry) => entry.result === 'block')) return 'block'
  const validated = target.safeParse(subject)
  if (!validated.success || !id.safeParse(nativeTurnId).success) throw new CompletionContractError()
  const siblings = prior.cycles.filter((entry) => key(entry.target) === key(validated.data) && entry.nativeTurnId === nativeTurnId)
  if (siblings.length === 2 && siblings[1]!.result === 'reject') return 'block'
  if (prior.revision !== prior.persistedRevision || prior.cycles.some((entry) => entry.result === 'pending') || siblings.length === 0) return 'hold'
  const last = siblings[siblings.length - 1]!
  return last.result === 'allow' ? 'complete' : last.result === 'reject' ? 'one-correction' : 'hold'
}
