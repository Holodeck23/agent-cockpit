import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchCodex } from '../../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import { createThreadManager } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u04-1: when `turn/start` is rejected by the Codex app-server (JSON-RPC error), fail() in
// server/agents/codex/launch.ts emits only {kind:'error'}. No 'result' is emitted and `turnStarting` is
// never reset. The thread manager only clears turnRunning on 'result' / 'exit', so the conversation stays
// 'working' forever, Stop only arms `interruptOnStart`, and that stale flag interrupts the NEXT turn the
// moment Codex names it.
// CORRECT behaviour: a rejected turn/start ends the turn (error then failed result), the conversation is
// not left 'working', and a Stop pressed afterwards does not poison the next successful turn.

// A stand-in app-server. The FIRST turn/start is rejected with a JSON-RPC error; later ones succeed and
// name a turn (turn/started) that then keeps running. Every request method is logged.
function fakeCodex(): { executable: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-u04-1-'))
  const log = join(dir, 'requests.log')
  const executable = join(dir, 'codex')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
let turns = 0
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, m.method + '\\n')
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'config/read') send({ id: m.id, result: {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"config":{}}]} })
    if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th1' } } })
    if (m.method === 'turn/start') {
      turns += 1
      if (turns === 1) send({ id: m.id, error: { code: -32602, message: 'invalid params: unsupported effort' } })
      else { send({ id: m.id, result: {} }); send({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'tu' + turns } } }) }
    }
    if (m.method === 'turn/interrupt') send({ id: m.id, result: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  return { executable, log }
}
const SLOW = 20_000
const requests = (log: string): string[] => { try { return readFileSync(log, 'utf8').trim().split('\n') } catch { return [] } }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('u04-1: a rejected Codex turn/start must end the turn', () => {
  it('adapter: emits a failed result after the error so the turn is over', async () => {
    const { executable } = fakeCodex()
    const events: NormalizedEvent[] = []
    const session = launchCodex({ cwd: tmpdir() }, (e) => events.push(e), { executable })
    try {
      session.send('hello')
      await expect.poll(() => events.some((e) => e.kind === 'error'), { timeout: 10_000 }).toBe(true)
      await sleep(300)
      const errorAt = events.findIndex((e) => e.kind === 'error')
      expect(events.slice(errorAt).some((e) => e.kind === 'result')).toBe(true)
    } finally {
      await session.close()
    }
  }, SLOW)

  it('manager: the conversation is not left "working" after turn/start is rejected', async () => {
    const { executable } = fakeCodex()
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-audit-u04-1-store-')))
    const manager = createThreadManager(store, { launchers: { codex: (req, onEvent) => launchCodex({ cwd: req.cwd }, onEvent, { executable }) } })
    const settings = threadSettingsSchema.parse({ agent: 'codex' })
    try {
      const meta = manager.create({ projectPath: tmpdir(), settings, text: 'hello' })
      await expect.poll(() => store.events(meta.id).some(({ event }) => event.kind === 'error'), { timeout: 10_000 }).toBe(true)
      await sleep(300)
      // The turn failed, so the conversation shows Error (or at worst idle), never an endless "working".
      expect(manager.status(meta.id)).not.toBe('working')
    } finally {
      await manager.shutdown()
    }
  }, SLOW)

  it('manager: Stop after the rejection does not interrupt the next successful turn', async () => {
    const { executable, log } = fakeCodex()
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-audit-u04-1-store-')))
    const manager = createThreadManager(store, { launchers: { codex: (req, onEvent) => launchCodex({ cwd: req.cwd }, onEvent, { executable }) } })
    const settings = threadSettingsSchema.parse({ agent: 'codex' })
    try {
      const meta = manager.create({ projectPath: tmpdir(), settings, text: 'hello' })
      await expect.poll(() => store.events(meta.id).some(({ event }) => event.kind === 'error'), { timeout: 10_000 }).toBe(true)
      // The user sees the error and presses Stop, then tries again; this time Codex accepts the turn.
      manager.interrupt(meta.id)
      manager.send(meta.id, 'try again')
      await expect.poll(() => requests(log).filter((m) => m === 'turn/start').length, { timeout: 10_000 }).toBe(2)
      await sleep(500)
      expect(requests(log)).not.toContain('turn/interrupt')
    } finally {
      await manager.shutdown()
    }
  }, SLOW)
})
