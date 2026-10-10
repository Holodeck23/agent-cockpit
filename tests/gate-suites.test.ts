import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { GATE_SUITES, gateVerdict, lastVerdictLine, suitePassed, type SuiteResult } from '../scripts/lib/gate-suites.ts'

const result = (name: string, run: number, ok = true): SuiteResult => ({ name, run, exit: ok ? 0 : 1, seconds: 1, last: ok ? `${name} PASS (3 checks)` : `FAIL  ${name} step` })

describe('the release gate list', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts

  it('names each suite once and only runs npm scripts that exist', () => {
    expect(new Set(GATE_SUITES.map((s) => s.name)).size).toBe(GATE_SUITES.length)
    for (const suite of GATE_SUITES) expect(scripts[suite.script], suite.script).toBeDefined()
  })

  it('never includes a proof that spends provider usage or needs real devices', () => {
    const live = ['proof:app', 'proof:mcp', 'proof:limit', 'proof:files', 'proof:workflows', 'proof:onboarding', 'proof:phone', 'proof:updates',
      'proof:approvals-live', 'proof:live-pair', 'proof:live-model-swap', 'proof:antigravity-images-live', 'proof:activity']
    expect(GATE_SUITES.filter((s) => live.includes(s.script))).toEqual([])
  })

  it('carries every wave and cross-feature acceptance family of the frozen contract', () => {
    const covered = GATE_SUITES.flatMap((s) => s.covers).join(' ')
    for (const id of ['BASE-01', 'BASE-02', 'R0', 'R9', 'W7-01', 'POL-01', 'W9-01', 'SEC-01', 'SEC-04', 'W10-01', 'W11-01', 'W12-01', 'W12-05', 'W12-09',
      'CROSS-01', 'CROSS-02', 'CROSS-03', 'CROSS-04', 'CROSS-05', 'CROSS-06', 'CROSS-08', 'CROSS-09', 'CROSS-10']) expect(covered, id).toContain(id)
  })

  it('keeps the release runner\'s original four proofs', () => {
    for (const name of ['startup', 'recovery', 'recovery-legacy', 'window-key']) expect(GATE_SUITES.some((s) => s.name === name), name).toBe(true)
    expect(GATE_SUITES.find((s) => s.name === 'recovery-legacy')?.args).toEqual(['--legacy'])
  })

  it('declares the v0.1.5 upgrade build the CROSS-09 proof opens', () => {
    expect(GATE_SUITES.find((s) => s.name === 'cross-accounts-worktrees')?.needs?.[0]).toMatch(/^release\/v0\.1\.5\/proof\//)
    expect(existsSync('scripts/proof-cross-accounts-worktrees.ts')).toBe(true)
  })
})

describe('reading a proof\'s verdict', () => {
  it('takes the last PASS or FAIL line', () => {
    expect(lastVerdictLine('PASS  one\nFAIL  two\nproof:x FAIL (1 of 9)\n')).toBe('proof:x FAIL (1 of 9)')
    expect(lastVerdictLine('nothing\n')).toBe('')
  })

  it('needs exit 0 and a PASS verdict, and a FAIL anywhere in that line fails it', () => {
    expect(suitePassed({ exit: 0, last: 'PROOF X PASS (3 checks)' })).toBe(true)
    expect(suitePassed({ exit: 1, last: 'PROOF X PASS (3 checks)' })).toBe(false)
    expect(suitePassed({ exit: 0, last: '' })).toBe(false)
    expect(suitePassed({ exit: 0, last: 'PASS  a step, but proof FAIL' })).toBe(false)
  })
})

describe('the gate verdict', () => {
  const names = ['a', 'b']

  it('passes only on the required number of whole consecutive passes', () => {
    const three = [1, 2, 3].flatMap((run) => names.map((n) => result(n, run)))
    expect(gateVerdict(three, names, 3)).toEqual({ passed: true, cleanRuns: 3 })
    expect(gateVerdict(three.slice(0, 4), names, 3)).toEqual({ passed: false, cleanRuns: 2 })
  })

  it('a failure in any run fails the gate and is named, even if later runs pass', () => {
    const results = [result('a', 1), result('b', 1, false), result('a', 2), result('b', 2), result('a', 3), result('b', 3)]
    const verdict = gateVerdict(results, names, 3)
    expect(verdict.passed).toBe(false)
    expect(verdict.cleanRuns).toBe(0)
    expect(verdict.firstFailure).toMatchObject({ name: 'b', run: 1 })
  })

  it('a suite missing from a run is not a pass', () => {
    expect(gateVerdict([result('a', 1)], names, 1)).toEqual({ passed: false, cleanRuns: 0 })
  })
})
