// Real-provider gate. Pass the exact CLI and a durable private evidence directory.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { launchClaude } from '../server/agents/claude/launch.ts'
import type { NormalizedEvent, AgentSession } from '../server/agents/types.ts'

const [executable, output] = process.argv.slice(2)
if (!executable || !output) throw new Error('Usage: smoke-claude-compatibility.ts <CLI> <durable-output-directory>')
const cwd = resolve(output, 'project')
mkdirSync(cwd, { recursive: true })
assert(!existsSync(join(cwd, 'denied.txt')) && !existsSync(join(cwd, 'allowed.txt')), 'Use a fresh output directory for each live gate')
const events: NormalizedEvent[] = []
const sessionId = randomUUID()
let session: AgentSession
let complete: ((event: NormalizedEvent) => void) | undefined
let decision: 'allow' | 'deny' = 'deny'
let target = 'denied.txt'
let asked = 0
let unexpected = 0
const sink = (event: NormalizedEvent) => {
  events.push(event)
  writeFileSync(join(output, 'events.json'), JSON.stringify(events, null, 2))
  if (event.kind === 'error') console.log('Agent error:', event.message)
  if (event.kind === 'approval_request') {
    const input = event.input as { file_path?: string }
    const expected = event.toolName === 'Write' && input.file_path === join(cwd, target)
    if (expected) asked++
    else unexpected++
    session.respondApproval({ requestId: event.requestId, input: event.input, suggestions: event.suggestions }, expected ? decision : 'deny')
  }
  if (event.kind === 'result' || event.kind === 'exit') complete?.(event)
}
async function turn(text: string) {
  const result = await new Promise<NormalizedEvent>((resolve, reject) => {
    const timer = setTimeout(() => { complete = undefined; reject(new Error('Live gate timed out; no retry')) }, 120_000)
    complete = (event) => { clearTimeout(timer); complete = undefined; resolve(event) }
    session.send(text)
  })
  assert(result.kind === 'result' && result.ok, 'Live turn did not complete successfully; stop without retry')
}
const deps = { executable, env: { DISABLE_AUTOUPDATER: '1' } }
try {
  session = launchClaude({ cwd, sessionId, model: 'haiku' }, sink, deps)
  await turn(`Remember the codeword tangerine for later. Use the Write tool to write exactly DENIED to ${join(cwd, target)}. If permission is denied, do not retry or use another tool; reply DENIED and stop. Do not use other tools.`)
  assert(asked > 0, 'Deny must have a real approval request')
  assert.equal(unexpected, 0, 'Unexpected tool requests invalidate this bounded gate')
  assert(!existsSync(join(cwd, target)), 'Denied write must not exist')
  console.log('PASS real Deny prevented file creation')
  decision = 'allow'; target = 'allowed.txt'; asked = 0
  await turn(`Use only the Write tool to write exactly ALLOWED to ${join(cwd, target)}, then reply OK.`)
  assert(asked > 0, 'Allow must have a real approval request')
  assert.equal(unexpected, 0, 'Unexpected tool requests invalidate this bounded gate')
  assert.equal(readFileSync(join(cwd, target), 'utf8').trim(), 'ALLOWED')
  console.log('PASS real Allow executed only after host response')
  await session.close()
  const before = events.length
  session = launchClaude({ cwd, resume: sessionId, model: 'haiku' }, sink, deps)
  await turn('What was the codeword? Reply with the single word only. Do not use tools.')
  assert(events.slice(before).some((e) => e.kind === 'assistant_text' && /tangerine/i.test(e.text)))
  console.log('PASS native resume across processes retained context')
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ executable, sessionId, deny: true, allow: true, resume: true }, null, 2))
  console.log('CLAUDE COMPATIBILITY LIVE PASS')
} finally { await session!?.close() }
