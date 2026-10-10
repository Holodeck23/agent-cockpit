import { describe, expect, it } from 'vitest'
import {
  descendantsOf,
  gatePassesProcessCleanup,
  parseProcessTable,
  processIdentity,
  survivingOwnedProcesses,
} from '../scripts/lib/gate-processes.ts'

const row = (pid: number, ppid: number, command: string, second = '00') =>
  `${pid} ${ppid} Fri Oct 10 08:00:${second} 2026 ${command}`

describe('gate-owned process cleanup', () => {
  it('makes an observed descendant survivor fail an otherwise clean qualifying gate', () => {
    const during = parseProcessTable([row(400, 10, 'npm run proof'), row(410, 400, 'node fixture.js')].join('\n'))
    const observed = new Map(descendantsOf(during, 400).map((process) => [processIdentity(process), process]))
    const after = parseProcessTable(row(410, 1, 'node fixture.js'))
    const leaks = survivingOwnedProcesses(after, observed, new Set())
    expect(leaks).toEqual([{ pid: 410, command: 'node fixture.js' }])
    expect(gatePassesProcessCleanup(true, leaks)).toBe(false)
  })

  it('ignores unrelated Cockpit processes and the gate ancestry', () => {
    const during = parseProcessTable([row(400, 10, 'npm run proof'), row(410, 400, 'node fixture.js'), row(300, 1, 'node scripts/gate.ts')].join('\n'))
    const observed = new Map(descendantsOf(during, 400).map((process) => [processIdentity(process), process]))
    const ancestry = during[2]!
    observed.set(processIdentity(ancestry), ancestry)
    const after = parseProcessTable([
      row(100, 1, '/Applications/Cockpit.app/Contents/MacOS/Cockpit'),
      row(300, 1, 'node scripts/gate.ts'),
    ].join('\n'))
    expect(survivingOwnedProcesses(after, observed, new Set([300]))).toEqual([])
    expect(gatePassesProcessCleanup(true, [])).toBe(true)
  })

  it('does not confuse a recycled PID with the process observed during the suite', () => {
    const old = parseProcessTable(row(410, 400, 'node fixture.js', '00'))[0]!
    const observed = new Map([[processIdentity(old), old]])
    const reused = parseProcessTable(row(410, 1, 'unrelated later process', '01'))
    expect(survivingOwnedProcesses(reused, observed, new Set())).toEqual([])
  })
})
