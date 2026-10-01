// Real Antigravity subscription run: two turns in separate `agy` processes,
// resuming the conversation id that the first process assigned.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

const cwd = mkdtempSync(join(tmpdir(), 'cockpit-antigravity-smoke-'))
const model = process.env.COCKPIT_ANTIGRAVITY_MODEL ?? 'gemini-3.8-flash-low'

function runTurn(prompt: string, resume?: string): Promise<NormalizedEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NormalizedEvent[] = []
    const timer = setTimeout(() => reject(new Error('turn timed out after 180s')), 180_000)
    const session = launchAntigravity({ cwd, model, effort: 'low', permissionMode: 'plan', resume }, (event) => {
      events.push(event)
      if (event.kind === 'result') void session.close()
      if (event.kind === 'exit') {
        clearTimeout(timer)
        resolve(events)
      }
    })
    session.send(prompt)
  })
}

const reply = (events: NormalizedEvent[]): string =>
  events.flatMap((event) => event.kind === 'assistant_text' ? [event.text] : []).join(' ')

const first = await runTurn('Remember the codeword: tangerine. Reply only with OK. Do not use tools.')
const session = first.find((event) => event.kind === 'session')
if (session?.kind !== 'session') throw new Error('Antigravity did not report a conversation id')
const second = await runTurn('What was the codeword? Reply with the single word only. Do not use tools.', session.sessionId)

console.log('turn 1:', reply(first))
console.log('turn 2:', reply(second))
const passed = first.some((event) => event.kind === 'result' && event.ok) && /tangerine/i.test(reply(second))
console.log(passed ? 'SMOKE PASS: Antigravity conversation resume keeps context' : 'SMOKE FAIL')
process.exit(passed ? 0 : 1)
