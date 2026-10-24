import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

// Faithful to 0.162.1: a unified_exec command owns its own process group and survives
// model-turn interruption. Only the thread terminal RPC ends it. No provider usage.
describe('Codex foreground command Stop through a real app-server pipe', () => {
  it('ends the live command before Stopped, preserves another session, and accepts a follow-up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-terminal-stop-'))
    const executable = join(root, 'codex')
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { createInterface } = require('node:readline')
const root = process.cwd()
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const note = (method, params) => send({ method, params })
let command, turn = 0
createInterface({ input: process.stdin }).on('line', (line) => {
 const m = JSON.parse(line)
 if (m.method === 'initialize') send({ id: m.id, result: {} })
 if (m.method === 'config/read') send({ id: m.id, result: {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"version":"sha256:0000000000000000000000000000000000000000000000000000000000000000","config":{}}]} })
 if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } })
 if (m.method === 'turn/start') {
  turn++
  send({ id: m.id, result: {} })
  note('turn/started', { threadId: 'thread', turn: { id: 'turn-' + turn } })
  if (turn > 1) {
   note('item/completed', { threadId: 'thread', item: { type: 'agentMessage', id: 'reply', text: 'follow-up accepted' } })
   note('turn/completed', { threadId: 'thread', turn: { id: 'turn-' + turn, status: 'completed' } })
   return
  }
  command = spawn('/bin/sh', ['-c', 'while [ ! -f release ]; do sleep 0.05; done; sleep 1; echo SHOULD_NOT_RUN > marker'], { detached: true, stdio: 'ignore' })
  fs.writeFileSync(root + '/command.pid', String(command.pid))
  note('item/started', { threadId: 'thread', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', processId: 'terminal', command: 'while [ ! -f release ]; do sleep 0.05; done; sleep 1; echo SHOULD_NOT_RUN > marker' } })
 }
 if (m.method === 'turn/interrupt') {
  send({ id: m.id, result: {} })
  note('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'interrupted' } })
 }
 if (m.method === 'thread/backgroundTerminals/terminate') {
  if (m.params.threadId !== 'thread' || m.params.processId !== 'terminal') throw Error('wrong scope')
  command.once('exit', (code, signal) => {
   note('item/completed', { threadId: 'thread', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', processId: 'terminal', exitCode: -1, status: 'failed' } })
   send({ id: m.id, result: { terminated: true } })
  })
  process.kill(-command.pid, 'SIGTERM')
 }
}).on('close', () => {
 if (command && command.exitCode === null && command.signalCode === null) { try { process.kill(-command.pid, 'SIGTERM') } catch {} }
})
`)
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const first = join(root, 'first')
    const other = join(root, 'other')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(first); mkdirSync(other)
    const session = launchCodex({ cwd: first }, (event) => events.push(event), { executable })
    const unrelated = launchCodex({ cwd: other }, () => {}, { executable })
    try {
      session.send('run command')
      unrelated.send('run independent command')
      await expect.poll(() => existsSync(join(first, 'command.pid')) && existsSync(join(other, 'command.pid')), { timeout: 5000 }).toBe(true)
      const pid = Number(readFileSync(join(first, 'command.pid'), 'utf8'))
      const otherPid = Number(readFileSync(join(other, 'command.pid'), 'utf8'))
      session.interrupt()
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.stopped), { timeout: 5000 }).toBe(true)
      expect(() => process.kill(pid, 0)).toThrow()
      expect(() => process.kill(otherPid, 0)).not.toThrow()
      expect(session.alive()).toBe(true)
      session.send('next deliberate message')
      await expect.poll(() => events.some((e) => e.kind === 'assistant_text' && e.text === 'follow-up accepted'), { timeout: 5000 }).toBe(true)
      // The side effect after sleep must never run in the canceled command, even later.
      writeFileSync(join(first, 'release'), '')
      writeFileSync(join(other, 'release'), '')
      await expect.poll(() => existsSync(join(other, 'marker')), { timeout: 5000 }).toBe(true)
      expect(readFileSync(join(other, 'marker'), 'utf8')).toContain('SHOULD_NOT_RUN')
      expect(existsSync(join(first, 'marker'))).toBe(false)
    } finally {
      await Promise.all([session.close(), unrelated.close()])
    }
  })
})
