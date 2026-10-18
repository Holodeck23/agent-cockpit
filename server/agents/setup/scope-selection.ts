// Domino 2 contract only. Persist these private controls before acknowledging any future change.
// Absence inherits; an explicit off record is a durable tombstone and never falls back.
import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().min(1).max(300).refine((text) => text.trim() === text && !/[\u0000-\u001f\u007f]/.test(text))
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const provider = z.enum(['claude', 'codex', 'antigravity', 'opencode'])
const familySchema = z.enum(['memory', 'skills'])
const reference = z.strictObject({ id, revision: z.string().regex(/^[a-f0-9]{64}$/) }).readonly()
const account = z.strictObject({ provider, accountId: id, accountGeneration: generation }).readonly()
const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: id }).readonly(),
  z.strictObject({ kind: z.literal('workspace'), projectId: id, workspaceId: id }).readonly(),
  z.strictObject({ kind: z.literal('conversation'), projectId: id, workspaceId: id, threadId: id }).readonly(),
])
const choice = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('inherit') }).readonly(),
  z.strictObject({ state: z.literal('off'), revokedSelection: reference.optional() }).readonly(),
  z.strictObject({ state: z.literal('selected'), selection: reference }).readonly(),
])
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), recordId: id, revision: generation,
  family: familySchema, scope: scopeSchema, account, choice,
}).readonly()
const recordsSchema = z.array(recordSchema).max(10_000).readonly()
const contextSchema = account.unwrap().extend({ projectId: id, workspaceId: id, threadId: id }).readonly()
export type ScopedSelectionRecord = z.output<typeof recordSchema>
export type SelectionContext = z.output<typeof contextSchema>
export type SelectionFamily = z.output<typeof familySchema>
export type SelectionReference = z.output<typeof reference>
export type SelectionResolution = Readonly<{
  /** Sensitive revision fingerprint, private to the host. Not a dispatch grant or qualification. */
  policyRevision: string
  consulted: readonly ScopedSelectionRecord[]
} & (
  | { state: 'selected'; selection: SelectionReference }
  | { state: 'off'; reason: 'explicit-off' | 'no-selection' }
  | { state: 'blocked'; reason: 'ambiguous-scope' | 'stale-account-generation' }
)>

export class ScopeSelectionError extends Error {
  constructor() { super('Scoped setup selection records are invalid') }
}

/** Immutable current controls; previous source/overlay revisions remain in a separate private journal. */
export function parseScopedSelectionRecords(raw: unknown): readonly ScopedSelectionRecord[] {
  const parsed = recordsSchema.safeParse(raw)
  if (!parsed.success) throw new ScopeSelectionError()
  return parsed.data
}

function matchesScope(scope: ScopedSelectionRecord['scope'], kind: ScopedSelectionRecord['scope']['kind'], context: SelectionContext): boolean {
  if (scope.kind !== kind || scope.projectId !== context.projectId) return false
  if (scope.kind === 'project') return true
  if (scope.workspaceId !== context.workspaceId) return false
  return scope.kind !== 'conversation' || scope.threadId === context.threadId
}

/**
 * Closest explicit choice wins: conversation/workspace binding, workspace, then project.
 * Inheritance never crosses provider/account identity; stale generations block instead of falling back.
 * A selected reference still requires source, ownership, readiness and consent validation at dispatch.
 */
export function resolveScopedSelection(rawRecords: unknown, rawContext: unknown, family: SelectionFamily): SelectionResolution {
  const records = parseScopedSelectionRecords(rawRecords)
  const parsed = contextSchema.safeParse(rawContext), checkedFamily = familySchema.safeParse(family)
  if (!parsed.success || !checkedFamily.success) throw new ScopeSelectionError()
  const context = parsed.data
  const consulted: ScopedSelectionRecord[] = []
  const finish = (result: { state: 'selected'; selection: SelectionReference }
    | { state: 'off'; reason: 'explicit-off' | 'no-selection' }
    | { state: 'blocked'; reason: 'ambiguous-scope' | 'stale-account-generation' }): SelectionResolution => Object.freeze({
      ...result, consulted: Object.freeze([...consulted]),
      policyRevision: createHash('sha256').update('cockpit-scope-selection-v1\0')
        .update(JSON.stringify({ context, family: checkedFamily.data, consulted })).digest('hex'),
    })
  for (const kind of ['conversation', 'workspace', 'project'] as const) {
    const rows = records.filter((row) => row.family === checkedFamily.data
      && row.account.provider === context.provider && row.account.accountId === context.accountId
      && matchesScope(row.scope, kind, context))
    if (rows.length > 1) {
      // Stable fingerprint even when a corrupt ledger lists duplicate records in a different order.
      consulted.push(...rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      return finish({ state: 'blocked', reason: 'ambiguous-scope' })
    }
    const row = rows[0]
    if (!row) continue
    consulted.push(row)
    if (row.account.accountGeneration !== context.accountGeneration) return finish({ state: 'blocked', reason: 'stale-account-generation' })
    if (row.choice.state === 'off') return finish({ state: 'off', reason: 'explicit-off' })
    if (row.choice.state === 'selected') return finish({ state: 'selected', selection: row.choice.selection })
  }
  return finish({ state: 'off', reason: 'no-selection' })
}
