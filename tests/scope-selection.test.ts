import { describe, expect, it } from 'vitest'
import { parseScopedSelectionRecords, resolveScopedSelection, ScopeSelectionError,
  type ScopedSelectionRecord, type SelectionContext } from '../server/agents/setup/scope-selection.ts'

const context: SelectionContext = { provider: 'claude', accountId: 'managed-one', accountGeneration: 1,
  projectId: 'project-one', workspaceId: 'worktree-one', threadId: 'thread-one' }
const reference = (id: string) => ({ id, revision: 'a'.repeat(64) })
function record(kind: 'project' | 'workspace' | 'conversation', choice: ScopedSelectionRecord['choice'], extra: Partial<ScopedSelectionRecord> = {}): ScopedSelectionRecord {
  const scope = kind === 'project' ? { kind, projectId: context.projectId }
    : kind === 'workspace' ? { kind, projectId: context.projectId, workspaceId: context.workspaceId }
      : { kind, projectId: context.projectId, workspaceId: context.workspaceId, threadId: context.threadId }
  return { schemaVersion: 1, recordId: `control-${kind}`, revision: 1, family: 'memory', scope,
    account: { provider: context.provider, accountId: context.accountId, accountGeneration: context.accountGeneration }, choice, ...extra }
}
const chosen = (kind: 'project' | 'workspace' | 'conversation') => record(kind, { state: 'selected', selection: reference(`selection-${kind}`) })

describe('private setup scope inheritance and off tombstones', () => {
  it('defaults to no selected source and inherits only through the current account/project scope chain', () => {
    expect(resolveScopedSelection([], context, 'memory')).toMatchObject({ state: 'off', reason: 'no-selection' })
    const project = chosen('project'), workspace = record('workspace', { state: 'inherit' }), conversation = record('conversation', { state: 'inherit' })
    const result = resolveScopedSelection([project, workspace, conversation], context, 'memory')
    expect(result).toMatchObject({ state: 'selected', selection: reference('selection-project') })
    expect(result.consulted.map((row) => row.scope.kind)).toEqual(['conversation', 'workspace', 'project'])
    expect(Object.isFrozen(result.consulted[0]!.choice)).toBe(true)
  })

  it('uses the closest selected revision without conflating same-name or parent selections', () => {
    expect(resolveScopedSelection([chosen('project'), chosen('workspace')], context, 'memory')).toMatchObject({ selection: reference('selection-workspace') })
    const result = resolveScopedSelection([chosen('project'), chosen('workspace'), chosen('conversation')], context, 'memory')
    expect(result).toMatchObject({ state: 'selected', selection: reference('selection-conversation') })
    expect(result.consulted).toHaveLength(1)
  })

  it.each(['workspace', 'conversation'] as const)('retains explicit off at %s across roundtrip and parent edits', (kind) => {
    const off = record(kind, { state: 'off', revokedSelection: reference('old-private-selection') })
    const records = parseScopedSelectionRecords(JSON.parse(JSON.stringify([chosen('project'), off])))
    expect(resolveScopedSelection(records, context, 'memory')).toMatchObject({ state: 'off', reason: 'explicit-off' })
    const changed = record('project', { state: 'selected', selection: reference('changed-parent') }, { revision: 2 })
    const unchangedOff = resolveScopedSelection([changed, off], context, 'memory')
    expect(unchangedOff).toMatchObject({ state: 'off', reason: 'explicit-off' })
    expect(unchangedOff.policyRevision).toBe(resolveScopedSelection(records, context, 'memory').policyRevision)
    expect(records[1]!.choice).toEqual({ state: 'off', revokedSelection: reference('old-private-selection') })
    expect(resolveScopedSelection(records.filter((row) => row.scope.kind !== kind), context, 'memory').state).toBe('selected')
    const explicitInherit = { ...off, revision: 2, choice: { state: 'inherit' } }
    expect(resolveScopedSelection([changed, explicitInherit], context, 'memory')).toMatchObject({ state: 'selected', selection: reference('changed-parent') })
  })

  it('does not reveal broader memory when the narrow selection is stale or explicitly off', () => {
    const stale = { ...chosen('conversation'), account: { ...chosen('conversation').account, accountGeneration: 2 } }
    expect(resolveScopedSelection([chosen('project'), stale], context, 'memory')).toMatchObject({ state: 'blocked', reason: 'stale-account-generation' })
    expect(resolveScopedSelection([chosen('project'), { ...stale, choice: { state: 'off' } }], context, 'memory').state).toBe('blocked')
    expect(resolveScopedSelection([chosen('project'), { ...stale, choice: { state: 'inherit' } }], context, 'memory').state).toBe('blocked')
  })

  it.each(['provider', 'accountId', 'projectId', 'workspaceId', 'threadId'] as const)('does not transplant a conversation selection across %s', (field) => {
    const other = { ...context, [field]: field === 'provider' ? 'codex' : 'different' }
    expect(resolveScopedSelection([chosen('conversation')], other, 'memory')).toMatchObject({ state: 'off', reason: 'no-selection' })
  })

  it('keeps independent providers/accounts/families without loading another account as fallback', () => {
    const row = chosen('project'), other = { ...row, account: { ...row.account, provider: 'codex' as const, accountId: 'codex-one' } }
    expect(resolveScopedSelection([other], context, 'memory')).toMatchObject({ state: 'off', reason: 'no-selection' })
    expect(resolveScopedSelection([row, other], context, 'memory')).toMatchObject({ selection: row.choice.state === 'selected' ? row.choice.selection : undefined })
    expect(resolveScopedSelection([row], context, 'skills')).toMatchObject({ state: 'off', reason: 'no-selection' })
  })

  it('blocks duplicate controls without choosing whichever appeared first', () => {
    const selected = chosen('workspace'), off = record('workspace', { state: 'off' }, { recordId: 'other-control' })
    const first = resolveScopedSelection([selected, off, chosen('project')], context, 'memory')
    const second = resolveScopedSelection([off, selected, chosen('project')], context, 'memory')
    expect(first).toMatchObject({ state: 'blocked', reason: 'ambiguous-scope' })
    expect(first.policyRevision).toBe(second.policyRevision)
  })

  it('binds the policy revision to current generation, consulted control revisions and exact selections', () => {
    const row = chosen('project'), original = resolveScopedSelection([row], context, 'memory')
    for (const changed of [{ ...row, revision: 2 }, { ...row, choice: { state: 'selected', selection: reference('changed') } }]) {
      expect(resolveScopedSelection([changed], context, 'memory').policyRevision).not.toBe(original.policyRevision)
    }
    expect(resolveScopedSelection([row], { ...context, accountGeneration: 2 }, 'memory').policyRevision).not.toBe(original.policyRevision)
    const unused = { ...chosen('project'), family: 'skills' as const }
    expect(resolveScopedSelection([row, unused], context, 'memory').policyRevision).toBe(original.policyRevision)
  })

  it('rejects unknown/missing state instead of treating damaged off records as inheritance', () => {
    for (const bad of [{ ...chosen('project'), choice: {} }, { ...chosen('project'), schemaVersion: 2 },
      { ...chosen('project'), choice: { state: 'off', secret: 'PRIVATE_CANARY' } }, { ...chosen('project'), revision: 0 }]) {
      expect(() => resolveScopedSelection([bad], context, 'memory')).toThrow('Scoped setup selection records are invalid')
    }
    expect(() => resolveScopedSelection([], { ...context, accountGeneration: 0 }, 'memory')).toThrow(ScopeSelectionError)
    expect(() => resolveScopedSelection([], context, 'unknown' as 'memory')).toThrow(ScopeSelectionError)
  })
})
