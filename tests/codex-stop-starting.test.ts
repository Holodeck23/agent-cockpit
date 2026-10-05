import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAcp } from '../server/agents/acp/launch.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

// A stand-in app-server: answers initialize, holds thread/start for HOLD_MS, names turns only
// after TURN_MS, and logs every request it gets so the test can see what Codex was asked.
function fakeCodex(holdMs: number, turnMs: number): { executable: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-stop-'))
  const log = join(dir, 'requests.log')
  const executable = join(dir, 'codex')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, m.method + '\\n')
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'thread/start') setTimeout(() => send({ id: m.id, result: { thread: { id: 'th1' } } }), ${holdMs})
    if (m.method === 'turn/start') setTimeout(() => { send({ id: m.id, result: {} }); send({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'tu1' } } }) }, ${turnMs})
    if (m.method === 'turn/interrupt') send({ id: m.id, result: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  return { executable, log }
}
const requests = (log: string): string[] => { try { return readFileSync(log, 'utf8').trim().split('\n') } catch { return [] } }

describe('Stop while an agent is starting (Day 10)', () => {
  it('before the thread exists: the message never reaches Codex and the turn ends stopped', async () => {
    const { executable, log } = fakeCodex(300, 0)
    const events: NormalizedEvent[] = []
    const session = launchCodex({ cwd: process.cwd() }, (e) => events.push(e), { executable })
    session.send('hello')
    session.interrupt()
    expect(events).toContainEqual({ kind: 'result', ok: false, stopped: true })
    await expect.poll(() => events.some((e) => e.kind === 'session')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requests(log)).not.toContain('turn/start')
    await session.close()
  })

  it('after turn/start but before Codex names the turn: interrupts it as soon as it is named', async () => {
    const { executable, log } = fakeCodex(0, 200)
    const events: NormalizedEvent[] = []
    const session = launchCodex({ cwd: process.cwd() }, (e) => events.push(e), { executable })
    session.send('hello')
    await expect.poll(() => requests(log).includes('turn/start')).toBe(true)
    session.interrupt()
    await expect.poll(() => requests(log).includes('turn/interrupt'), { timeout: 2000 }).toBe(true)
    await session.close()
  })

  it('ACP (OpenCode) before the session exists: the prompt never goes out and the turn ends stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-acp-stop-'))
    const log = join(dir, 'requests.log')
    const executable = join(dir, 'acp')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, m.method + '\\n')
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    if (m.method === 'session/new') setTimeout(() => send({ id: m.id, result: { sessionId: 's1' } }), 300)
  }
})
`)
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const session = launchAcp({ agent: 'opencode', label: 'OpenCode', command: executable, args: [], cwd: process.cwd() }, (e) => events.push(e))
    session.send('hello')
    session.interrupt()
    expect(events).toContainEqual({ kind: 'result', ok: false, stopped: true })
    await expect.poll(() => events.some((e) => e.kind === 'session')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requests(log)).not.toContain('session/prompt')
    await session.close()
  })
})
