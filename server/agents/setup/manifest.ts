/** Host-owned setup inventory. This module is pure: discovery and provider launches live in adapters. */
export const SETUP_MANIFEST_VERSION = 1

export type SetupKind = 'hook' | 'mcp' | 'instruction' | 'memory' | 'skill'
export type SetupEvidence = 'call' | 'load' | 'policy-denial' | 'invocation'
export type SetupLayer = 'source' | 'native' | 'packaged' | 'installed'
export type SetupLifecycle = 'initial' | 'later' | 'resumed' | 'compacted'
export const REQUIRED_SETUP_LIFECYCLES: readonly SetupLifecycle[] = ['initial', 'later', 'resumed', 'compacted']

export interface SetupCapability {
  /** Qualified by kind, source and native name; duplicate native names remain distinct. */
  readonly id: string
  readonly kind: SetupKind
  readonly nativeName: string
  readonly sourceId: string
  readonly sourceRevision: string
  readonly enabled: boolean
  readonly selected: boolean
  readonly approved: boolean
  readonly role: 'policy' | 'enrichment'
  readonly requiredEvidence: SetupEvidence
  readonly unavailableReason?: string
  readonly shadowedBy?: string
}

export interface SetupObservation {
  readonly capabilityId: string
  readonly evidence: SetupEvidence
  readonly layer: SetupLayer
  readonly lifecycle: SetupLifecycle
  readonly runId: string
  readonly accountGeneration: number
  readonly generation: number
  readonly sourceRevision: string
  readonly succeeded: boolean
}

export interface SetupManifest {
  readonly schemaVersion: typeof SETUP_MANIFEST_VERSION
  readonly provider: string
  readonly adapterVersion: string
  readonly accountId: string
  readonly accountGeneration: number
  readonly projectId: string
  readonly workspaceId: string
  readonly launchGeneration: number
  /** The run that supplied each lifecycle receipt; an older run cannot qualify a new launch. */
  readonly lifecycleRuns: Readonly<Partial<Record<SetupLifecycle, string>>>
  /** False until native discovery and precedence have accounted for every applicable source. */
  readonly expectedInventoryComplete: boolean
  /** A native comparison is required even when the provider has no capabilities of one kind. */
  readonly nativeBaseline?: Readonly<{ revision: string; launchGeneration: number; compared: boolean }>
  readonly capabilities: readonly SetupCapability[]
  readonly observations: readonly SetupObservation[]
}

export interface SetupAssessment {
  readonly fullParity: boolean
  readonly unmet: readonly { id: string; reason: string }[]
}

/** Never allow an approved subset, old observation or missing lifecycle to count as parity. */
export function assessSetupManifest(manifest: SetupManifest, layer: SetupLayer): SetupAssessment {
  const unmet: { id: string; reason: string }[] = []
  if (manifest.schemaVersion !== SETUP_MANIFEST_VERSION) unmet.push({ id: 'manifest', reason: 'Unsupported schema version' })
  if (!manifest.expectedInventoryComplete) unmet.push({ id: 'manifest', reason: 'Expected source inventory is incomplete' })
  if (!manifest.nativeBaseline?.compared || !manifest.nativeBaseline.revision
    || manifest.nativeBaseline.launchGeneration !== manifest.launchGeneration) {
    unmet.push({ id: 'manifest', reason: 'No current native baseline comparison' })
  }
  const ids = new Set<string>()
  for (const capability of manifest.capabilities) {
    if (ids.has(capability.id)) unmet.push({ id: capability.id, reason: 'Duplicate capability identity' })
    ids.add(capability.id)
    if (!capability.enabled || capability.shadowedBy) continue
    if (capability.unavailableReason) unmet.push({ id: capability.id, reason: capability.unavailableReason })
    if (!capability.selected) unmet.push({ id: capability.id, reason: 'Expected capability was not selected' })
    if (!capability.approved) unmet.push({ id: capability.id, reason: 'Expected capability was not approved' })
    for (const lifecycle of REQUIRED_SETUP_LIFECYCLES) {
      const runId = manifest.lifecycleRuns[lifecycle]
      if (!runId) {
        unmet.push({ id: capability.id, reason: `No current ${lifecycle} run identity` })
        continue
      }
      const observed = manifest.observations.some((row) => row.capabilityId === capability.id
        && row.evidence === capability.requiredEvidence && row.layer === layer && row.lifecycle === lifecycle
        && row.runId === runId && row.accountGeneration === manifest.accountGeneration
        && row.generation === manifest.launchGeneration && row.sourceRevision === capability.sourceRevision && row.succeeded)
      if (!observed) unmet.push({ id: capability.id, reason: `No current ${layer} ${lifecycle} ${capability.requiredEvidence} evidence` })
    }
  }
  return { fullParity: unmet.length === 0, unmet }
}
