import { expect, it } from 'vitest'
import { assessSetupManifest, SETUP_MANIFEST_VERSION, type SetupManifest } from '../server/agents/setup/manifest.ts'

const manifest = (): SetupManifest => ({
  schemaVersion: SETUP_MANIFEST_VERSION, provider: 'claude', adapterVersion: 'fixture-1',
  accountId: 'account-one', accountGeneration: 1, projectId: 'project', workspaceId: 'worktree',
  launchGeneration: 2, lifecycleRuns: { initial: 'run-1', later: 'run-2', resumed: 'run-3', compacted: 'run-4' },
  expectedInventoryComplete: true,
  nativeBaseline: { revision: 'baseline-1', launchGeneration: 2, compared: true },
  capabilities: [{ id: 'mcp:source:tool', kind: 'mcp', nativeName: 'tool', sourceId: 'source',
    sourceRevision: 'rev-1', enabled: true, selected: true, approved: true,
    role: 'enrichment', requiredEvidence: 'call' }],
  observations: (['initial', 'later', 'resumed', 'compacted'] as const).map((lifecycle, index) => ({
    capabilityId: 'mcp:source:tool', evidence: 'call', layer: 'packaged', lifecycle,
    runId: `run-${index + 1}`, accountGeneration: 1, generation: 2, sourceRevision: 'rev-1', succeeded: true,
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
  expect(assessSetupManifest({ ...ready, lifecycleRuns: { ...ready.lifecycleRuns, initial: 'run-other' } }, 'packaged').fullParity).toBe(false)
  expect(assessSetupManifest({ ...ready, accountGeneration: 2 }, 'packaged').fullParity).toBe(false)
})

it('keeps same-name capabilities distinct by qualified identity', () => {
  const ready = manifest()
  const other = { ...ready.capabilities[0]!, id: 'mcp:other:tool', sourceId: 'other' }
  const result = assessSetupManifest({ ...ready, capabilities: [...ready.capabilities, other] }, 'packaged')
  expect(result.fullParity).toBe(false)
  expect(result.unmet).toContainEqual({ id: other.id, reason: 'No current packaged initial call evidence' })
})
