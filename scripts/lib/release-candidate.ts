import { GATE_SUITES, gateVerdict, type SuiteResult } from './gate-suites.ts'

export const RELEASE_CANDIDATE_SCHEMA = 'agent-cockpit-release-candidate/v1'

export interface CandidateGateRecord {
  commit: string
  dirty: boolean
  appPackageSha256: string
  endPackageSha256: string
  appAsarSha256: string
  endAsarSha256: string
  appVersion: string
  requiredRuns: number
  subset: unknown
  voided: unknown
  processLeak: unknown
  verdict?: { passed?: boolean; cleanRuns?: number }
  suites: Array<{ name: string }>
  results: SuiteResult[]
  leftovers: unknown[]
}

export interface CandidateInstallVerification {
  version: string
  signature: string
  asar_installed: string
  asar_packaged: string
  asar_match: boolean
  package_installed: string
  package_packaged: string
  package_match: boolean
  dmg_sha256: string
  dmg_bytes: number
}

export interface CandidateArtifactFacts {
  version: string
  proofPackage: { path: string; packageSha256: string; appAsarSha256: string; version: string }
  productionPackage: { path: string; packageSha256: string; appAsarSha256: string; version: string }
  installer: { path: string; sha256: string; bytes: number }
  installedAppAsarSha256: string
  installedAppPackageSha256: string
  installVerification: CandidateInstallVerification
  gate: CandidateGateRecord
  gatePath: string
  gateSha256: string
}

export interface ReleaseCandidateRecord {
  schema: typeof RELEASE_CANDIDATE_SCHEMA
  createdAt: string
  version: string
  sourceRevision: string
  proofPackage: CandidateArtifactFacts['proofPackage']
  productionPackage: CandidateArtifactFacts['productionPackage']
  installer: CandidateArtifactFacts['installer'] & {
    version: string
    installedAppPackageSha256: string
    installedAppAsarSha256: string
  }
  qualifyingGate: {
    path: string
    sha256: string
    commit: string
    proofPackageSha256: string
    proofAppAsarSha256: string
    requiredRuns: number
    cleanRuns: number
  }
}

export function createReleaseCandidateRecord(facts: CandidateArtifactFacts, createdAt = new Date().toISOString()): ReleaseCandidateRecord {
  return {
    schema: RELEASE_CANDIDATE_SCHEMA,
    createdAt,
    version: facts.version,
    sourceRevision: facts.gate.commit,
    proofPackage: facts.proofPackage,
    productionPackage: facts.productionPackage,
    installer: {
      ...facts.installer,
      version: facts.installVerification.version,
      installedAppPackageSha256: facts.installedAppPackageSha256,
      installedAppAsarSha256: facts.installedAppAsarSha256,
    },
    qualifyingGate: {
      path: facts.gatePath,
      sha256: facts.gateSha256,
      commit: facts.gate.commit,
      proofPackageSha256: facts.gate.appPackageSha256,
      proofAppAsarSha256: facts.gate.appAsarSha256,
      requiredRuns: facts.gate.requiredRuns,
      cleanRuns: facts.gate.verdict?.cleanRuns ?? 0,
    },
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Every identity publish trusts must agree with both the record and the artifact on disk. */
export function releaseCandidateBindingErrors(recordValue: unknown, facts: CandidateArtifactFacts, requiredRuns: number): string[] {
  const errors: string[] = []
  const record = object(recordValue)
  if (!record) return ['candidate record is missing or is not a JSON object']
  const proof = object(record.proofPackage)
  const production = object(record.productionPackage)
  const installer = object(record.installer)
  const qualifyingGate = object(record.qualifyingGate)
  const gate = facts.gate
  const install = facts.installVerification

  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) errors.push(`${label} does not match`)
  }

  equal(record.schema, RELEASE_CANDIDATE_SCHEMA, 'candidate record schema')
  equal(record.version, facts.version, 'candidate version')
  equal(record.sourceRevision, gate.commit, 'source revision and gate commit')

  equal(proof?.path, facts.proofPackage.path, 'proof package path')
  equal(proof?.packageSha256, facts.proofPackage.packageSha256, 'proof package hash')
  equal(proof?.appAsarSha256, facts.proofPackage.appAsarSha256, 'proof app.asar hash')
  equal(proof?.version, facts.proofPackage.version, 'proof package version')
  equal(production?.path, facts.productionPackage.path, 'production package path')
  equal(production?.packageSha256, facts.productionPackage.packageSha256, 'production package hash')
  equal(production?.appAsarSha256, facts.productionPackage.appAsarSha256, 'production app.asar hash')
  equal(production?.version, facts.productionPackage.version, 'production package version')
  equal(installer?.path, facts.installer.path, 'installer path')
  equal(installer?.sha256, facts.installer.sha256, 'installer hash')
  equal(installer?.bytes, facts.installer.bytes, 'installer size')
  equal(installer?.version, install.version, 'installer version')
  equal(installer?.installedAppPackageSha256, facts.installedAppPackageSha256, 'installed app package hash')
  equal(installer?.installedAppAsarSha256, facts.installedAppAsarSha256, 'installed app hash')

  equal(qualifyingGate?.path, facts.gatePath, 'qualifying gate path')
  equal(qualifyingGate?.sha256, facts.gateSha256, 'qualifying gate record hash')
  equal(qualifyingGate?.commit, gate.commit, 'recorded gate commit')
  equal(qualifyingGate?.proofPackageSha256, gate.appPackageSha256, 'recorded gate package hash')
  equal(qualifyingGate?.proofAppAsarSha256, gate.appAsarSha256, 'recorded gate app.asar hash')
  equal(qualifyingGate?.requiredRuns, gate.requiredRuns, 'recorded required gate runs')
  equal(qualifyingGate?.cleanRuns, gate.verdict?.cleanRuns, 'recorded clean gate runs')

  equal(gate.appPackageSha256, facts.proofPackage.packageSha256, 'gate and proof package hash')
  equal(gate.endPackageSha256, facts.proofPackage.packageSha256, 'end-of-gate and proof package hash')
  equal(gate.appAsarSha256, facts.proofPackage.appAsarSha256, 'gate and proof app.asar hash')
  equal(gate.endAsarSha256, facts.proofPackage.appAsarSha256, 'end-of-gate and proof app.asar hash')
  equal(gate.appVersion, facts.proofPackage.version, 'gate and proof package version')
  if (gate.dirty) errors.push('qualifying gate ran from a dirty tree')
  if (gate.subset !== null) errors.push('qualifying gate is a subset')
  if (gate.voided !== null) errors.push('qualifying gate was voided')
  if (gate.processLeak !== null) errors.push('qualifying gate recorded an owned process leak')
  if (gate.verdict?.passed !== true) errors.push('qualifying gate did not pass')
  const gateRuns = Number.isInteger(gate.requiredRuns) ? gate.requiredRuns : 0
  if (gateRuns < requiredRuns || (gate.verdict?.cleanRuns ?? 0) < gateRuns) {
    errors.push(`qualifying gate did not complete ${requiredRuns} clean runs`)
  }
  if (!Array.isArray(gate.leftovers)) errors.push('qualifying gate has no process-cleanup record')
  else if (gate.leftovers.length > 0) errors.push('qualifying gate recorded owned process leaks')

  const expectedSuites = GATE_SUITES.map((suite) => suite.name)
  const recordedSuites = Array.isArray(gate.suites) ? gate.suites.map((suite) => suite?.name) : []
  if (JSON.stringify(recordedSuites) !== JSON.stringify(expectedSuites)) errors.push('qualifying gate suite list is stale or incomplete')
  const results = Array.isArray(gate.results) ? gate.results : []
  const resultKeys = results.map((result) => `${result.run}:${result.name}`)
  if (results.length !== expectedSuites.length * gateRuns || new Set(resultKeys).size !== resultKeys.length) {
    errors.push('qualifying gate does not contain exactly one result per suite and run')
  }
  const recomputed = gateVerdict(results, expectedSuites, gateRuns)
  if (!recomputed.passed || recomputed.cleanRuns !== gateRuns) errors.push('qualifying gate results do not independently pass')
  equal(gate.verdict?.cleanRuns, recomputed.cleanRuns, 'recorded and recomputed clean gate runs')

  equal(install.version, facts.version, 'installed version')
  equal(install.signature, 'ok', 'installed signature')
  equal(install.package_packaged, facts.productionPackage.packageSha256, 'install check and production package hash')
  equal(install.package_installed, facts.installedAppPackageSha256, 'install check and installed app package hash')
  equal(install.package_installed, facts.productionPackage.packageSha256, 'installed and production package hash')
  equal(install.asar_packaged, facts.productionPackage.appAsarSha256, 'install check and production app.asar hash')
  equal(install.asar_installed, facts.installedAppAsarSha256, 'install check and installed app.asar hash')
  equal(install.asar_installed, facts.productionPackage.appAsarSha256, 'installed and production app.asar hash')
  equal(install.dmg_sha256, facts.installer.sha256, 'install check and installer hash')
  equal(install.dmg_bytes, facts.installer.bytes, 'install check and installer size')
  if (!install.asar_match) errors.push('install check did not match the production package')
  if (!install.package_match) errors.push('installed app package did not match the production package')

  return errors
}

export function isAllowedPostBuildChange(path: string): boolean {
  return path.startsWith('landing/') || path.endsWith('.md')
}
