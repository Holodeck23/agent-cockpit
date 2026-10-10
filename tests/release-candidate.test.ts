import { describe, expect, it } from 'vitest'
import {
  createReleaseCandidateRecord,
  isAllowedPostBuildChange,
  releaseCandidateBindingErrors,
  type CandidateArtifactFacts,
} from '../scripts/lib/release-candidate.ts'
import { GATE_SUITES } from '../scripts/lib/gate-suites.ts'

const facts = (build: 'one' | 'two' = 'one'): CandidateArtifactFacts => {
  const suffix = build === 'one' ? '1' : '2'
  const commit = suffix.repeat(40)
  const proof = `proof-${suffix}`
  const production = `production-${suffix}`
  const installer = `installer-${suffix}`
  const suites = GATE_SUITES.map(({ name }) => ({ name }))
  const results = [1, 2, 3].flatMap((run) => suites.map(({ name }) => ({ name, run, exit: 0, seconds: 1, last: `${name} PASS` })))
  return {
    version: '0.1.7',
    proofPackage: { path: 'release/v0.1.7/proof/mac-arm64/Cockpit.app', packageSha256: `proof-package-${suffix}`, appAsarSha256: proof, version: '0.1.7' },
    productionPackage: { path: 'release/v0.1.7/mac-arm64/Cockpit.app', packageSha256: `production-package-${suffix}`, appAsarSha256: production, version: '0.1.7' },
    installer: { path: 'release/v0.1.7/Cockpit-0.1.7-arm64.dmg', sha256: installer, bytes: build === 'one' ? 101 : 202 },
    installedAppAsarSha256: production,
    installedAppPackageSha256: `production-package-${suffix}`,
    installVerification: {
      version: '0.1.7', signature: 'ok', asar_installed: production, asar_packaged: production,
      asar_match: true, dmg_sha256: installer, dmg_bytes: build === 'one' ? 101 : 202,
      package_installed: `production-package-${suffix}`, package_packaged: `production-package-${suffix}`, package_match: true,
    },
    gate: {
      commit, dirty: false, appPackageSha256: `proof-package-${suffix}`, endPackageSha256: `proof-package-${suffix}`,
      appAsarSha256: proof, endAsarSha256: proof, appVersion: '0.1.7',
      requiredRuns: 3, subset: null, voided: null, processLeak: null, verdict: { passed: true, cleanRuns: 3 },
      suites, results, leftovers: [],
    },
    gatePath: 'evidence/gate/gate.json',
    gateSha256: `gate-${suffix}`,
  }
}

describe('release candidate binding', () => {
  it('accepts one matching build whose gate and install facts agree with the actual artifacts', () => {
    const actual = facts()
    const record = createReleaseCandidateRecord(actual, '2026-10-10T00:00:00.000Z')
    expect(releaseCandidateBindingErrors(record, actual, 3)).toEqual([])
  })

  it('rejects build-one evidence paired with build-two packages even when both gates say passed', () => {
    const record = createReleaseCandidateRecord(facts('one'))
    const errors = releaseCandidateBindingErrors(record, facts('two'), 3)
    expect(errors).toEqual(expect.arrayContaining([
      'source revision and gate commit does not match',
      'proof package hash does not match',
      'production package hash does not match',
      'installer hash does not match',
      'qualifying gate record hash does not match',
    ]))
  })

  it('rejects a missing record and a stale gate hash instead of trusting a passed boolean', () => {
    const actual = facts()
    expect(releaseCandidateBindingErrors(undefined, actual, 3)).toContain('candidate record is missing or is not a JSON object')
    const record = createReleaseCandidateRecord(actual)
    record.qualifyingGate.sha256 = 'older-gate'
    expect(releaseCandidateBindingErrors(record, actual, 3)).toContain('qualifying gate record hash does not match')
    const standaloneBoolean = facts()
    standaloneBoolean.gate.results = []
    expect(releaseCandidateBindingErrors(createReleaseCandidateRecord(standaloneBoolean), standaloneBoolean, 3))
      .toContain('qualifying gate results do not independently pass')
  })

  it('allows only landing and Markdown changes after the bound source revision', () => {
    expect(['landing/index.html', 'docs/RELEASE-ACCEPTANCE.md'].every(isAllowedPostBuildChange)).toBe(true)
    expect(isAllowedPostBuildChange('scripts/release.ts')).toBe(false)
    expect(isAllowedPostBuildChange('electron/main.ts')).toBe(false)
  })
})
