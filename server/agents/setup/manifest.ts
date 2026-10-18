/** Host-owned setup inventory. This module is pure: discovery and provider launches live in adapters. */
export const SETUP_MANIFEST_VERSION = 2

export type SetupKind = 'hook' | 'mcp' | 'instruction' | 'memory' | 'skill' | 'agent'
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

/** Opaque host identities only. Private paths, memory contents and credential values stay elsewhere. */
export interface SetupScopeIdentity {
  readonly provider: string
  readonly providerVersion: string
  /** Pins the provider executable and every interpreter used by this adapter. */
  readonly runtimeRevision: string
  readonly adapterVersion: string
  readonly accountId: string
  readonly accountGeneration: number
  readonly principalId: string
  readonly credentialContextId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly bindingId: string
  readonly sourceRevision: string
  /** Pins source, harness, fixtures, dependencies and command inputs for this qualification. */
  readonly qualificationId: string
}

export interface SetupRunIdentity {
  readonly runId: string
  readonly nativeSessionId: string
  readonly launchGeneration: number
}

export interface SetupObservation {
  readonly capabilityId: string
  readonly evidence: SetupEvidence
  readonly scope: SetupScopeIdentity
  readonly layer: SetupLayer
  readonly artifactId: string
  readonly lifecycle: SetupLifecycle
  readonly run: SetupRunIdentity
  readonly sourceRevision: string
  readonly succeeded: boolean
}

export interface SetupManifest {
  readonly schemaVersion: typeof SETUP_MANIFEST_VERSION
  readonly scope: SetupScopeIdentity
  readonly launchGeneration: number
  /** Lifecycle evidence keeps the generation/session of its own launch across legitimate restart. */
  readonly lifecycleRuns: Readonly<Partial<Record<SetupLifecycle, SetupRunIdentity>>>
  readonly artifact: Readonly<{ layer: SetupLayer; id: string }>
  /** False until native discovery and precedence have accounted for every applicable source. */
  readonly expectedInventoryComplete: boolean
  /** Native observations are bound to the same scope and qualification, never just a revision label. */
  readonly nativeBaseline?: Readonly<{ revision: string; scope: SetupScopeIdentity; compared: boolean }>
  readonly capabilities: readonly SetupCapability[]
  readonly observations: readonly SetupObservation[]
}

const SCOPE_TEXT_FIELDS = ['provider', 'providerVersion', 'runtimeRevision', 'adapterVersion',
  'accountId', 'principalId', 'credentialContextId', 'projectId', 'workspaceId', 'bindingId',
  'sourceRevision', 'qualificationId'] as const
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const generation = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const validScope = (scope: SetupScopeIdentity): boolean =>
  SCOPE_TEXT_FIELDS.every((key) => nonempty(scope[key])) && generation(scope.accountGeneration)
const sameScope = (left: SetupScopeIdentity, right: SetupScopeIdentity): boolean =>
  validScope(left) && validScope(right) && left.accountGeneration === right.accountGeneration
    && SCOPE_TEXT_FIELDS.every((key) => left[key] === right[key])
const validRun = (run: SetupRunIdentity): boolean =>
  nonempty(run.runId) && nonempty(run.nativeSessionId) && generation(run.launchGeneration)
const sameRun = (left: SetupRunIdentity, right: SetupRunIdentity): boolean =>
  validRun(left) && validRun(right) && left.runId === right.runId
    && left.nativeSessionId === right.nativeSessionId && left.launchGeneration === right.launchGeneration

export interface SetupAssessment {
  readonly fullParity: boolean
  readonly unmet: readonly { id: string; reason: string }[]
}

/** Never allow an approved subset, old observation or missing lifecycle to count as parity. */
export function assessSetupManifest(manifest: SetupManifest, layer: SetupLayer): SetupAssessment {
  const unmet: { id: string; reason: string }[] = []
  if (manifest.schemaVersion !== SETUP_MANIFEST_VERSION) unmet.push({ id: 'manifest', reason: 'Unsupported schema version' })
  if (!validScope(manifest.scope)) unmet.push({ id: 'manifest', reason: 'Incomplete scope identity' })
  if (!generation(manifest.launchGeneration)) unmet.push({ id: 'manifest', reason: 'Invalid launch generation' })
  if (manifest.artifact.layer !== layer || !nonempty(manifest.artifact.id)) {
    unmet.push({ id: 'manifest', reason: 'Missing or mismatched artifact identity' })
  }
  const runs = REQUIRED_SETUP_LIFECYCLES.map((phase) => manifest.lifecycleRuns[phase])
  if (runs.some((run) => !run || !validRun(run) || run.launchGeneration > manifest.launchGeneration)
    || !runs.some((run) => run?.launchGeneration === manifest.launchGeneration)) {
    unmet.push({ id: 'manifest', reason: 'Incomplete or stale lifecycle bindings' })
  }
  if (!manifest.expectedInventoryComplete) unmet.push({ id: 'manifest', reason: 'Expected source inventory is incomplete' })
  if (!manifest.nativeBaseline?.compared || !manifest.nativeBaseline.revision
    || !sameScope(manifest.nativeBaseline.scope, manifest.scope)) {
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
      const run = manifest.lifecycleRuns[lifecycle]
      if (!run || !validRun(run)) {
        unmet.push({ id: capability.id, reason: `No current ${lifecycle} run identity` })
        continue
      }
      const observed = manifest.observations.some((row) => row.capabilityId === capability.id
        && row.evidence === capability.requiredEvidence && row.layer === layer && row.lifecycle === lifecycle
        && sameScope(row.scope, manifest.scope) && sameRun(row.run, run)
        && row.artifactId === manifest.artifact.id && row.sourceRevision === capability.sourceRevision && row.succeeded)
      if (!observed) unmet.push({ id: capability.id, reason: `No current ${layer} ${lifecycle} ${capability.requiredEvidence} evidence` })
    }
  }
  return { fullParity: unmet.length === 0, unmet }
}
