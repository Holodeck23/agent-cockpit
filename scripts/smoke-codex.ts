// Real Codex run: two turns in two separate app-server processes, the second
// resuming the first by the thread id Codex assigned. Uses your ChatGPT plan.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

const cwd = mkdtempSync(join(tmpdir(), 'cockpit-codex-smoke-'))
const model = process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna'

function runTurn(prompt: string, resume?: string): Promise<NormalizedEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NormalizedEvent[] = []
    const timer = setTimeout(() => reject(new Error('turn timed out after 180s')), 180_000)
    const session = launchCodex({ cwd, model, permissionMode: 'plan', resume }, (event) => {
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

const first = await runTurn('Remember the codeword: tangerine. Reply only with OK. Do not run any commands.')
const threadId = first.find((e) => e.kind === 'session')
if (threadId?.kind !== 'session') throw new Error('Codex did not report a thread id')
const second = await runTurn('What was the codeword? Reply with the single word only. Do not run any commands.', threadId.sessionId)

console.log('turn 1:', reply(first))
console.log('turn 2:', reply(second))
const passed = /tangerine/i.test(reply(second))
console.log(passed ? 'SMOKE PASS: codex thread/resume keeps context' : 'SMOKE FAIL')
process.exit(passed ? 0 : 1)
