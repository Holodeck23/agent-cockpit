import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import { parseAntigravityLine } from '../server/agents/antigravity/parse.ts'
import type { AgentCapabilities } from '../server/agents/capabilities/types.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { usageLine } from '../web/src/usage.ts'

// The result line agy 1.3.0 printed for a one-word turn (order-12 recon, 2026-10-06).
const RECORDED_RESULT = '{"event":"result","result":{"conversation_id":"827b1a6f-1b9a-4c13-bbda-86b88b483689","status":"SUCCESS","response":"ok\\n","duration_seconds":5.894941,"num_turns":1,"usage":{"input_tokens":12901,"output_tokens":59,"thinking_tokens":58,"cache_read_tokens":0,"total_tokens":12960}}}'

describe('Antigravity usage (W10-03)', () => {
  it('reports the token counts agy printed for the turn, and nothing it did not', () => {
    const events = parseAntigravityLine(RECORDED_RESULT)
    const usage = events.find((e) => e.kind === 'usage')
    expect(usage).toEqual({ kind: 'usage', limitType: 'last_turn', status: '12,960 tokens (12,901 in, 59 out, 58 thinking)' })
    expect(usageLine(usage as Extract<NormalizedEvent, { kind: 'usage' }>)).toBe('Last turn usage: 12,960 tokens (12,901 in, 59 out, 58 thinking)')
    // No guessed percentage or plan.
    expect(usage).not.toHaveProperty('usedPercent')
    expect(usage).not.toHaveProperty('resetsAt')
  })

  it('shows partial counts as partial, and none when agy reports none', () => {
    const partial = JSON.parse(RECORDED_RESULT)
    partial.result.usage = { total_tokens: 500, cache_read_tokens: 120 }
    expect(parseAntigravityLine(JSON.stringify(partial)).find((e) => e.kind === 'usage')).toEqual({ kind: 'usage', limitType: 'last_turn', status: '500 tokens (120 cached)' })
    const odd = JSON.parse(RECORDED_RESULT)
    odd.result.usage = { input_tokens: 'many' }
    expect(parseAntigravityLine(JSON.stringify(odd)).some((e) => e.kind === 'usage')).toBe(false)
    const none = JSON.parse(RECORDED_RESULT)
    delete none.result.usage
    expect(parseAntigravityLine(JSON.stringify(none)).some((e) => e.kind === 'usage')).toBe(false)
  })
})

// Launch validation independent of the picker (W10-01) against the executable resolved now (W10-02).
function fakeAgy(): { dir: string; exe: string; launched: () => string[] | undefined } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-agy-launch-'))
  const exe = join(dir, 'agy-resolved')
  writeFileSync(exe, `#!/bin/sh
printf '%s\\n' "$@" > "${join(dir, 'launched')}"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "${join(dir, 'stdin')}"
  printf '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"ok"}}\\n'
done
`)
  chmodSync(exe, 0o755)
  return { dir, exe, launched: () => existsSync(join(dir, 'launched')) ? readFileSync(join(dir, 'launched'), 'utf8').trim().split('\n') : undefined }
}

const record = (exe: string, models: AgentCapabilities['models'], executable?: AgentCapabilities['executable']): AgentCapabilities => ({
  agent: 'antigravity', context: 'default', settings: {}, auth: { state: 'signed_in' }, models,
  executable: executable ?? { state: 'found', identity: { command: 'agy', path: exe, realpath: exe, fingerprint: 'f', version: '1.3.0' } },
})

function run(input: Parameters<typeof launchAntigravity>[0], check: () => Promise<AgentCapabilities>) {
  const events: NormalizedEvent[] = []
  const session = launchAntigravity(input, (e) => events.push(e), { executable: '/nonexistent/agy-from-picker', check })
  return { events, session }
}
const LISTED: AgentCapabilities['models'] = { state: 'supported', source: 'agy models', value: [{ id: 'gemini-3.8-flash-low' }] }

describe('Antigravity launch validation (W10-01, W10-02)', () => {
  it('refuses a model the installed agy does not list, before starting it', async () => {
    const agy = fakeAgy()
    const { events } = run({ cwd: agy.dir, model: 'gemini-9-ultra' }, async () => record(agy.exe, LISTED))
    await expect.poll(() => events.some((e) => e.kind === 'exit')).toBe(true)
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/does not offer the model gemini-9-ultra/) })
    expect(events).toContainEqual({ kind: 'result', ok: false })
    expect(agy.launched()).toBeUndefined()
  })

  it('refuses when agy is no longer installed, without falling back to another copy', async () => {
    const agy = fakeAgy()
    const { events } = run({ cwd: agy.dir }, async () => record(agy.exe, { state: 'not_checked' }, { state: 'missing', reason: 'agy is not installed or not on the PATH Cockpit uses' }))
    await expect.poll(() => events.some((e) => e.kind === 'exit')).toBe(true)
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/not installed/) })
    expect(agy.launched()).toBeUndefined()
  })

  it('runs the executable that was just checked, and delivers a message sent while checking', async () => {
    const agy = fakeAgy()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { events, session } = run({ cwd: agy.dir, model: 'gemini-3.8-flash-low' }, async () => { await gate; return record(agy.exe, LISTED) })
    session.send('hello')
    release()
    await expect.poll(() => events.some((e) => e.kind === 'result'), { timeout: 10_000 }).toBe(true)
    expect(agy.launched()).toContain('gemini-3.8-flash-low')
    expect(readFileSync(join(agy.dir, 'stdin'), 'utf8')).toContain('hello')
    session.close()
  })

  it('leaves the model to agy when its list could not be read', async () => {
    const agy = fakeAgy()
    const { events, session } = run({ cwd: agy.dir, model: 'gemini-new' }, async () => record(agy.exe, { state: 'unavailable', reason: 'agy models timed out' }))
    session.send('hi')
    await expect.poll(() => events.some((e) => e.kind === 'result'), { timeout: 10_000 }).toBe(true)
    expect(agy.launched()).toContain('gemini-new')
    session.close()
  })

  it('reports a failed check as an error and starts nothing', async () => {
    const agy = fakeAgy()
    const { events } = run({ cwd: agy.dir }, async () => { throw new Error('probe exploded') })
    await expect.poll(() => events.some((e) => e.kind === 'exit')).toBe(true)
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/Could not check Antigravity/) })
    expect(agy.launched()).toBeUndefined()
  })
})
