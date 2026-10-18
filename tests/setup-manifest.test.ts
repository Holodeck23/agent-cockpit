import { expect, it } from 'vitest'
import { assessSetupManifest, SETUP_MANIFEST_VERSION, type SetupManifest, type SetupScopeIdentity } from '../server/agents/setup/manifest.ts'

const scope = (): SetupScopeIdentity => ({
  provider: 'claude', providerVersion: 'fixture-1', runtimeRevision: 'runtime-1', adapterVersion: 'adapter-1',
  accountId: 'account-one', accountGeneration: 1, principalId: 'principal-one', credentialContextId: 'credential-one',
  projectId: 'project', workspaceId: 'worktree', bindingId: 'conversation-binding', sourceRevision: 'tree-1',
  qualificationId: 'frozen-inputs-1',
})
const phases = ['initial', 'later', 'resumed', 'compacted'] as const
const run = (index: number) => ({ runId: `run-${index + 1}`, nativeSessionId: index < 2 ? 'session-one' : 'session-two',
  launchGeneration: index < 2 ? 1 : 2 })
const manifest = (): SetupManifest => ({
  schemaVersion: SETUP_MANIFEST_VERSION, scope: scope(), launchGeneration: 2,
  lifecycleRuns: { initial: run(0), later: run(1), resumed: run(2), compacted: run(3) },
  artifact: { layer: 'packaged', id: 'proof-payload-1' }, expectedInventoryComplete: true,
  nativeBaseline: { revision: 'baseline-1', scope: scope(), compared: true },
  capabilities: [{ id: 'mcp:source:tool', kind: 'mcp', nativeName: 'tool', sourceId: 'source',
    sourceRevision: 'rev-1', enabled: true, selected: true, approved: true,
    role: 'enrichment', requiredEvidence: 'call' }],
  observations: phases.map((lifecycle, index) => ({
    capabilityId: 'mcp:source:tool', evidence: 'call', layer: 'packaged', artifactId: 'proof-payload-1',
    lifecycle, scope: scope(), run: run(index), sourceRevision: 'rev-1', succeeded: true,
  })),
})

it('requires the complete expected inventory and every requested lifecycle', () => {
  const ready = manifest()
  expect(assessSetupManifest(ready, 'packaged').fullParity).toBe(true)
  expect(assessSetupManifest({ ...ready, expectedInventoryComplete: false }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, capabilities: [], nativeBaseline: undefined }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, observations: ready.observations.filter((row) => row.lifecycle !== 'later') }, 'packaged').unmet)
    .toContainEqual({ id: 'mcp:source:tool', reason: 'No current packaged later call evidence' })
})

it('does not erase an expected capability when an executable subset omits it', () => {
  const ready = manifest()
  const omitted = { ...ready.capabilities[0]!, id: 'hook:other:guard', kind: 'hook' as const,
    nativeName: 'guard', sourceId: 'other', selected: false, approved: false,
    role: 'policy' as const, requiredEvidence: 'policy-denial' as const,
    unavailableReason: 'Dynamic command unresolved' }
  const result = assessSetupManifest({ ...ready, capabilities: [...ready.capabilities, omitted] }, 'packaged')
  expect(result.fullParity).toBe(false)
  expect(result.unmet.filter((row) => row.id === omitted.id)).toHaveLength(7)
})

it('rejects stale source and launch generations and evidence from a different layer', () => {
  const ready = manifest()
  expect(assessSetupManifest({ ...ready, launchGeneration: 3 }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, capabilities: [{ ...ready.capabilities[0]!, sourceRevision: 'rev-2' }] },
    'packaged').fullParity).toBe(false)
  expect(assessSetupManifest(ready, 'installed').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, lifecycleRuns: { ...ready.lifecycleRuns, initial: { ...run(0), runId: 'run-other' } } }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, scope: { ...ready.scope, accountGeneration: 2 } }, 'packaged').fullParity).toBe(false)
})

it('keeps same-name capabilities distinct by qualified identity', () => {
  const ready = manifest()
  const other = { ...ready.capabilities[0]!, id: 'mcp:other:tool', sourceId: 'other' }
  const result = assessSetupManifest({ ...ready, capabilities: [...ready.capabilities, other] }, 'packaged')
  expect(result.fullParity).toBe(false)
  expect(result.unmet).toContainEqual({ id: other.id, reason: 'No current packaged initial call evidence' })
})


it.each(Object.keys(scope()) as Array<keyof SetupScopeIdentity>)('rejects a receipt transplanted across %s', (field) => {
  const ready = manifest()
  const changed = { ...ready.scope, [field]: field === 'accountGeneration' ? 2 : 'different' }
  // Baseline and every observation must match, independently; matching run numbers do not suffice.
  const observations = ready.observations.map((row) => ({ ...row, scope: changed }))
  expect(assessSetupManifest({ ...ready, observations }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, nativeBaseline: { ...ready.nativeBaseline!, scope: changed } }, 'packaged').fullParity).toBe(false)
})

it('retains individual lifecycle generations across restart without authorizing another launch', () => {
  const ready = manifest()
  expect(assessSetupManifest(ready, 'packaged').fullParity).toBe(true)
  expect(assessSetupManifest({ ...ready, launchGeneration: 3 }, 'packaged').fullParity).toBe(false)
  const observations = ready.observations.map((row) => ({ ...row, run: { ...row.run, launchGeneration: 2 } }))
  expect(assessSetupManifest({ ...ready, observations }, 'packaged').fullParity).toBe(false)
})

it.each(['runId', 'nativeSessionId', 'launchGeneration'] as const)('rejects mismatched %s within a lifecycle', (field) => {
  const ready = manifest()
  const observations = ready.observations.map((row) => ({ ...row,
    run: { ...row.run, [field]: field === 'launchGeneration' ? 99 : 'different' } }))
  expect(assessSetupManifest({ ...ready, observations }, 'packaged').fullParity).toBe(false)
})

it('invalidates evidence when the package or qualification inputs change', () => {
  const ready = manifest()
  expect(assessSetupManifest({ ...ready, artifact: { ...ready.artifact, id: 'new-payload' } }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, observations: ready.observations.map((row) => ({ ...row, artifactId: 'shipping-payload' })) }, 'packaged').fullParity).toBe(false)
  const changed = { ...ready.scope, qualificationId: 'new-harness-or-fixtures' }
  expect(assessSetupManifest({ ...ready, scope: changed, nativeBaseline: { ...ready.nativeBaseline!, scope: changed } }, 'packaged').fullParity).toBe(false)
})

it('rejects incomplete scope, empty receipts, and invalid generations even when values match', () => {
  const ready = manifest()
  for (const invalid of [{ ...scope(), principalId: '' }, { ...scope(), accountGeneration: 0 }]) {
    expect(assessSetupManifest({ ...ready, scope: invalid, nativeBaseline: { ...ready.nativeBaseline!, scope: invalid },
      observations: ready.observations.map((row) => ({ ...row, scope: invalid })) }, 'packaged').fullParity).toBe(false)
  }
  expect(assessSetupManifest({ ...ready, capabilities: [], observations: [], lifecycleRuns: {} }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, launchGeneration: Number.NaN }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, artifact: { layer: 'packaged', id: '' } }, 'packaged').fullParity).toBe(false)
})
