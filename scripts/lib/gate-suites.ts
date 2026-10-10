// The cumulative release gate (ACCEPTANCE REL-02): every deterministic packaged proof the frozen
// completion contract requires, each tied to the acceptance IDs it carries. Stand-in agents,
// fixture Tailscale and local collectors only; no proof here spends provider usage or needs a
// person, a phone or a signed-in account. Live and human gates (W10-10, W11-08, REL-05/06/07/10,
// the live-pair/approvals/model-swap/limit checks) are recorded separately and never inferred
// from this list passing.

export interface GateSuite {
  /** The npm script that runs it. */
  readonly script: string
  /** Extra arguments after `--`. */
  readonly args?: readonly string[]
  /** Short name for logs and the summary; unique. */
  readonly name: string
  /** Acceptance and feature IDs this suite carries; EA-Dnn are the EA route's days, not feature Dnn. */
  readonly covers: readonly string[]
  /** Files under the repository the suite needs that a fresh checkout does not have. */
  readonly needs?: readonly string[]
}

/** A test image several proofs attach; gitignored, made by `npm run icon` (which also rewrites build/icon.icns). */
const ICON = 'build/icon-1024.png'

export const GATE_SUITES: readonly GateSuite[] = [
  // Baseline: waves 1–6, the 6.5 repair checkpoint, the window-only API and the cross-wave checks (BASE-01–08, R0–R9).
  { name: 'reliability', script: 'proof:reliability', covers: ['R0', 'BASE-01'] },
  { name: 'wave-1', script: 'proof:wave-1', covers: ['BASE-01', 'A1', 'A2', 'A3', 'A5', 'A6', 'A7', 'B1–B5'] },
  { name: 'wave-2', script: 'proof:wave-2', covers: ['BASE-01', 'C1–C8', 'D1–D9', 'E1'] },
  { name: 'wave-3', script: 'proof:wave-3', covers: ['BASE-01', 'A3', 'A8', 'A9', 'G1–G3'] },
  { name: 'wave-4', script: 'proof:wave-4', covers: ['BASE-01', 'A10', 'D10', 'F1–F14', 'F15'] },
  { name: 'wave-5', script: 'proof:wave-5', covers: ['BASE-01', 'A11', 'C9', 'J1–J3', 'J5–J7', 'J10', 'J11'] },
  { name: 'wave-6', script: 'proof:wave-6', covers: ['BASE-01', 'G4', 'I1', 'I2'], needs: [ICON] },
  { name: 'wave-6.5', script: 'proof:wave-6.5', covers: ['BASE-02–BASE-08', 'R1–R8'], needs: [ICON] },
  { name: 'window-key', script: 'proof:window-key', covers: ['R0', 'SEC-01'], needs: [ICON] },
  { name: 'cross-wave', script: 'proof:cross-wave', covers: ['R9', 'BASE-01'], needs: [ICON] },
  // Waves 7–12 and their combined checks.
  { name: 'wave-7', script: 'proof:wave-7', covers: ['W7-01–W7-10', 'A12', 'F16', 'J4', 'K1', 'K2'] },
  { name: 'scanner', script: 'proof:scanner', covers: ['POL-01', 'D12'] },
  { name: 'wave-9', script: 'proof:wave-9', covers: ['W9-01–W9-12', 'SEC-01–SEC-03', 'CROSS-03', 'CROSS-05', 'A4', 'G5', 'H1–H4'] },
  { name: 'preview', script: 'proof:preview', covers: ['W9-11'] },
  { name: 'wave-10', script: 'proof:wave-10', covers: ['W10-01–W10-09', 'L1–L4', 'P2', 'P3'] },
  { name: 'wave-11', script: 'proof:wave-11', covers: ['W11-01–W11-07', 'SEC-04–SEC-06', 'H5'] },
  { name: 'accounts', script: 'proof:accounts', covers: ['W12-01–W12-04', 'L5'] },
  { name: 'wave-12', script: 'proof:wave-12', covers: ['W12-05–W12-08', 'M1'] },
  { name: 'wave-12-lifecycle', script: 'proof:wave-12-lifecycle', covers: ['W12-09–W12-15', 'M1'] },
  { name: 'cross-flow', script: 'proof:cross-flow', covers: ['CROSS-01', 'CROSS-02', 'CROSS-08'], needs: [ICON] },
  { name: 'cross-lifecycle', script: 'proof:cross-lifecycle', covers: ['CROSS-06', 'CROSS-10'] },
  { name: 'cross-accounts-worktrees', script: 'proof:cross-accounts-worktrees', covers: ['CROSS-04', 'CROSS-09'],
    needs: ['release/v0.1.5/proof/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit'] },
  // Route and release behaviour added after the waves, plus the release runner's original four.
  { name: 'startup', script: 'proof:startup', covers: ['EA-D16', 'W10-01'] },
  { name: 'recovery', script: 'proof:recovery', covers: ['EA-D17'] },
  { name: 'recovery-legacy', script: 'proof:recovery', args: ['--legacy'], covers: ['EA-D17'] },
  { name: 'handoff', script: 'proof:handoff', covers: ['EA-D13', 'EA-D14', 'J5'] },
  { name: 'interruption', script: 'proof:interruption', covers: ['EA-D18', 'ID-06'] },
  { name: 'quit', script: 'proof:quit', covers: ['ID-06', 'CROSS-10'] },
  { name: 'crash-guard', script: 'proof:crash-guard', covers: ['EA-D16'] },
  { name: 'reports', script: 'proof:reports', covers: ['EA-D19', 'REL-09'] },
  { name: 'feedback', script: 'proof:feedback', covers: ['D4'] },
  { name: 'states', script: 'proof:states', covers: ['EA-D10', 'R10', 'BASE-08', 'J9'] },
  { name: 'find-inspect', script: 'proof:find-inspect', covers: ['EA-D20', 'A9'] },
  { name: 'antigravity', script: 'proof:antigravity', covers: ['I2', 'L3'] },
  { name: 'opencode', script: 'proof:opencode', covers: ['I2'] },
]

export interface SuiteResult {
  readonly name: string
  readonly run: number
  readonly exit: number | null
  readonly seconds: number
  /** The last PASS/FAIL line the proof printed. */
  readonly last: string
}

/** The last line a proof printed that says PASS or FAIL; proofs end with their own verdict. */
export function lastVerdictLine(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => /\b(PASS|FAIL)\b/.test(line))
  return lines.at(-1) ?? ''
}

/** A suite passed only if it exited 0 and its last verdict line says PASS and not FAIL. */
export function suitePassed(result: Pick<SuiteResult, 'exit' | 'last'>): boolean {
  return result.exit === 0 && /\bPASS\b/.test(result.last) && !/\bFAIL\b/.test(result.last)
}

export interface GateVerdict {
  readonly passed: boolean
  /** Consecutive whole passes, counted from the first run, before any failure. */
  readonly cleanRuns: number
  readonly firstFailure?: SuiteResult
}

/** A qualifying gate is `required` consecutive whole passes on one unchanged package. */
export function gateVerdict(results: readonly SuiteResult[], suites: readonly string[], required: number): GateVerdict {
  const firstFailure = results.find((result) => !suitePassed(result))
  let cleanRuns = 0
  for (let run = 1; ; run++) {
    const inRun = results.filter((result) => result.run === run)
    if (!suites.every((name) => inRun.some((result) => result.name === name && suitePassed(result)))) break
    cleanRuns = run
  }
  return { passed: !firstFailure && cleanRuns >= required, cleanRuns, ...(firstFailure ? { firstFailure } : {}) }
}
