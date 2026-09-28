// Phase 0 proof gate: two turns in two separate processes, the second resumed
// by session id, against the real `claude` CLI on Haiku (a few cents).
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchClaude } from '../server/agents/claude/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

const cwd = mkdtempSync(join(tmpdir(), 'cockpit-smoke-'))

function runTurn(prompt: string, ids: { sessionId?: string; resume?: string }): Promise<NormalizedEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NormalizedEvent[] = []
    const timer = setTimeout(() => reject(new Error('turn timed out after 120s')), 120_000)
    const session = launchClaude({ cwd, model: 'haiku', ...ids }, (event) => {
      events.push(event)
      if (event.kind === 'result') session.close()
      if (event.kind === 'exit') {
        clearTimeout(timer)
        resolve(events)
      }
    })
    session.send(prompt)
  })
}

const reply = (events: NormalizedEvent[]): string =>
  events.flatMap((e) => (e.kind === 'assistant_text' ? [e.text] : [])).join(' ')

const sessionId = randomUUID()
const first = await runTurn('Remember the codeword: tangerine. Reply only with OK.', { sessionId })
const second = await runTurn('What was the codeword? Reply with the single word only.', { resume: sessionId })

console.log('turn 1:', reply(first))
console.log('turn 2:', reply(second))
const passed = first.some((e) => e.kind === 'result' && e.ok) && /tangerine/i.test(reply(second))
console.log(passed ? 'SMOKE PASS: resume across processes keeps context' : 'SMOKE FAIL')
process.exit(passed ? 0 : 1)
