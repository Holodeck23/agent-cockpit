import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const fixture = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w13-batch-')))
  mkdirSync(join(root, 'cycles'))
  writeFileSync(join(root, 'expected-binding-private.json'), JSON.stringify({ sessionId: 'session', turnId: 'turn' }))
  return root
}
const input = (active = false) => ({ hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn', stop_hook_active: active })
const run = (root: string, value: unknown) => {
  const result = spawnSync(process.execPath, [resolve('scripts/fixtures/w13-stop-batch.cjs'), root], { input: JSON.stringify(value), encoding: 'utf8' })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}
describe('reviewed synthetic native completion batch', () => {
  it('journals both checks under one fresh persisted identity and blocks after one correction', () => {
    const root = fixture()
    expect(run(root, input())).toMatchObject({ decision: 'block' })
    expect(run(root, input(true))).toMatchObject({ continue: false })
    const decisions = ['1', '2'].map((i) => JSON.parse(readFileSync(join(root, 'cycles', i, 'decision-private.json'), 'utf8')))
    expect(decisions[0].cycleId).not.toBe(decisions[1].cycleId)
    expect(decisions.map((entry) => entry.disposition)).toEqual(['one-correction', 'block'])
    for (const decision of decisions) expect(decision.checks.map((check: any) => check.cycleId)).toEqual([decision.cycleId, decision.cycleId])
    expect(run(root, input(true))).toMatchObject({ continue: false })
    expect(readdirSync(join(root, 'cycles'))).toEqual(['1', '2'])
  })
  it.each(['session_id', 'turn_id', 'hook_event_name', 'stop_hook_active'])('stops on invalid native %s without creating a cycle', (field) => {
    const root = fixture()
    expect(run(root, { ...input(), [field]: 'wrong' })).toMatchObject({ continue: false })
    expect(readdirSync(join(root, 'cycles'))).toEqual([])
  })
  it('retains partial writes and refuses a fresh budget after a simulated interrupted journal', () => {
    const root = fixture(); mkdirSync(join(root, 'cycles', '1'))
    writeFileSync(join(root, 'cycles', '1', 'start-private.json'), 'retained')
    expect(run(root, input(true))).toMatchObject({ continue: false })
    expect(readFileSync(join(root, 'cycles', '1', 'start-private.json'), 'utf8')).toBe('retained')
  })
  it('fails closed on a concurrent owner while retaining its lock', () => {
    const root = fixture(); writeFileSync(join(root, 'batch.active'), 'owner')
    expect(run(root, input())).toMatchObject({ continue: false })
    expect(readFileSync(join(root, 'batch.active'), 'utf8')).toBe('owner')
  })
  it('does not accept a correction flag as a substitute for a persisted first batch', () => {
    const root = fixture()
    expect(run(root, input(true))).toMatchObject({ continue: false })
    expect(readdirSync(join(root, 'cycles'))).toEqual([])
  })
})
