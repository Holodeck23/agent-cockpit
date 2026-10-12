import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAntigravity } from '../../server/agents/antigravity/launch.ts'
import type { AgentSession, NormalizedEvent } from '../../server/agents/types.ts'

// u03-2: Stop sets `stopping` and ends the turn as stopped at once; agy's own "interrupted" result and
// stderr arrive a moment later and are dropped only while `stopping` is true. send() clears `stopping`
// unconditionally, so a message sent in that gap makes agy's late result for the STOPPED turn look like the
// result of the NEW turn (the manager has already set entry.runId to the new run), and its stderr is shown as
// an error. CORRECT behaviour: the stopped turn's late result and stderr are never credited to the new turn.

// A stand-in for agy 1.3.1 (tests/antigravity-stop.test.ts): on SIGINT it reports an "interrupted" result and
// writes "error: interrupted" to stderr. MODE=exit also exits 1 (what 1.3.1 does); MODE=survive keeps running
// and answers the next user line normally. DELAY_MS is the time agy takes to wind the stopped turn up.
const standIn = (mode: 'exit' | 'survive'): string => `#!${process.execPath}
const fs = require('fs')
const readline = require('readline')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const mode = ${JSON.stringify(mode)}
let turns = 0
out({ event: 'init', conversation_id: 'c', init: { model: 'm', cwd: '/p' } })
readline.createInterface({ input: process.stdin }).on('line', () => {
  turns += 1
  fs.writeFileSync(__dirname + '/turn-' + turns, '')
  if (turns >= 2) setTimeout(() => out({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'X done' } }), 600)
})
process.on('SIGINT', () => {
  setTimeout(() => {
    out({ event: 'result', result: { conversation_id: 'c', status: 'ERROR', response: 'interrupted' } })
    process.stderr.write('error: interrupted\\n')
    if (mode === 'exit') setTimeout(() => process.exit(1), 20)
  }, 300)
})
setInterval(() => {}, 1000)
`

async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!done() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 25))
}

/** Stop a running turn and send the next message straight away, before agy has printed its interrupted result. */
async function stopThenSend(mode: 'exit' | 'survive'): Promise<{ events: NormalizedEvent[]; afterSend: NormalizedEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), `agy-u03-2-${mode}-`))
  const executable = join(dir, 'agy')
  writeFileSync(executable, standIn(mode))
  chmodSync(executable, 0o755)
  const events: NormalizedEvent[] = []
  let session: AgentSession | undefined
  try {
    session = launchAntigravity({ cwd: dir }, (event) => { events.push(event) }, { executable })
    session.send('a long task')
    await waitFor(() => existsSync(join(dir, 'turn-1')), 10_000)
    expect(existsSync(join(dir, 'turn-1'))).toBe(true)

    session.interrupt() // emits { result, ok:false, stopped:true } at once; agy's own result follows ~300 ms later
    const mark = events.length
    session.send('actually do X instead')

    // Long enough for agy's late interrupted result (300 ms), its exit, and (survive) its answer to X (600 ms).
    await waitFor(() => events.some((e) => e.kind === 'exit') && mode === 'exit', 3_000)
    if (mode === 'survive') await new Promise((r) => setTimeout(r, 1500))
    return { events, afterSend: events.slice(mark) }
  } finally {
    await session?.close()
  }
}

const summary = (events: readonly NormalizedEvent[]) => events
  .filter((e) => e.kind === 'result' || e.kind === 'error')
  .map((e) => (e.kind === 'result' ? { kind: e.kind, ok: e.ok, stopped: e.stopped ?? false, text: e.text } : { kind: e.kind, message: e.message }))

describe('u03-2: Stop then an immediate send must not credit the stopped turn\'s late result to the new turn', () => {
  it('agy exits on SIGINT (1.3.1): no failed "interrupted" result and no stderr error appear after the new message', async () => {
    const { afterSend } = await stopThenSend('exit')
    // Correct: nothing agy says about the stopped turn is shown as a result/failure of the new message.
    expect(summary(afterSend)).toEqual([])
  }, 20_000)

  it('agy survives SIGINT: the new turn gets exactly its own result, not the stopped turn\'s', async () => {
    const { afterSend } = await stopThenSend('survive')
    expect(summary(afterSend)).toEqual([{ kind: 'result', ok: true, stopped: false, text: 'X done' }])
  }, 20_000)
})
