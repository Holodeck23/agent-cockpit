import { describe, expect, it } from 'vitest'
import { GALLERY } from '../../web/src/gallery/catalog.ts'

// u29-3: 'release-check' was a Plan-mode gallery job although its instructions run tests, the type
// check, lint and the build. The catalogue's rule (header comment, tests/gallery.test.ts): read-only
// jobs use Plan, anything that runs commands asks first (Manual). Plan mode tells the agent not to
// execute, so the job came back with a plan or no check output instead of the pass/fail report.
// CORRECT behaviour: a gallery job whose instructions tell the agent to run tests, builds, lint or a
// type check is Manual.

const entry = (name: string) => GALLERY.find((w) => w.name === name)!

// "run" / "runs" followed (in the same sentence) by something that executes project code.
const RUNS_CHECKS = /\bruns?\b[^.]*\b(tests?|test suite|type check|lint(er)?|build|checks)\b/i

describe('u29-3: gallery jobs that run commands ask first', () => {
  it('Release check is Manual, like Morning test run and Build report', () => {
    expect(entry('release-check').permissionMode).toBe('manual')
    expect(entry('morning-test-run').permissionMode).toBe('manual')
    expect(entry('build-report').permissionMode).toBe('manual')
  })

  it('no Plan-mode job tells the agent to run tests, a build, lint or a type check', () => {
    const offenders = GALLERY.filter((w) => w.permissionMode === 'plan' && RUNS_CHECKS.test(w.prompt)).map((w) => w.name)
    expect(offenders).toEqual([])
  })
})
