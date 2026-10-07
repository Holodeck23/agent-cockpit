import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import { launchClaude } from '../server/agents/claude/launch.ts'
import { createRpcClient } from '../server/agents/codex/rpc.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

// An agent CLI that stops reading (it crashed, or closed stdin) still looks writable until Node
// sees it exit. The next write then fails with EPIPE as an 'error' event; unhandled, that would
// end the whole server (H1). Vitest fails a file on an unhandled error, so passing is the proof.

const big = 'x'.repeat(256 * 1024)
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// macOS scans a freshly written executable on its first run (see claude-capabilities.test.ts).
const FIRST_RUN = { timeout: 5000 }

describe('an agent that stops taking input', () => {
  it('Claude: the lost write becomes an error event, not a crash', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-stdin-claude-'))
    const executable = join(cwd, 'claude')
    writeFileSync(join(cwd, 'help'), readFileSync('scripts/fixtures/claude-help.txt', 'utf8'))
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--help" ]; then cat help; exit 0; fi
printf '{"type":"system","subtype":"init","session_id":"stdin-lost"}\\n'
exec 0<&-
sleep 2
`)
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const session = launchClaude({ cwd }, (event) => events.push(event), { executable })
    try {
      await expect.poll(() => events.some((e) => e.kind === 'session'), FIRST_RUN).toBe(true)
      session.send(big)
      session.send(big)
      await expect.poll(() => events.some((e) => e.kind === 'error' && /stopped taking input/.test(e.message))).toBe(true)
      expect(session.alive()).toBe(true)
    } finally { await session.close() }
  })

  it('Antigravity: the lost write becomes an error event, not a crash', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-stdin-agy-'))
    const executable = join(cwd, 'agy')
    writeFileSync(executable, '#!/bin/sh\nexec 0<&-\nsleep 2\n')
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const session = launchAntigravity({ cwd }, (event) => events.push(event), { executable })
    try {
      await settle(300)
      session.send(big)
      session.send(big)
      await expect.poll(() => events.some((e) => e.kind === 'error' && /stopped taking input/.test(e.message)), FIRST_RUN).toBe(true)
    } finally { await session.close() }
  }, FIRST_RUN.timeout * 3) // the settle plus a full first-run poll must fit inside the test

  it('JSON-RPC (Codex, ACP): the lost write is a protocol error, not a crash', async () => {
    const child = spawn('/bin/sh', ['-c', 'exec 0<&-; sleep 2'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const errors: string[] = []
    const rpc = createRpcClient(child, { onNotification() {}, onServerRequest() {}, onProtocolError: (message) => errors.push(message) })
    try {
      await settle(300)
      rpc.notify('big', { text: big })
      rpc.notify('big', { text: big })
      await expect.poll(() => errors.some((m) => /stopped taking input/.test(m))).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('JSON-RPC: a handler that throws on a message becomes a protocol error, not a crash', async () => {
    const child = spawn('/bin/sh', ['-c', 'printf \'{"method":"odd/notice","params":{}}\\n{"id":7,"method":"odd/request","params":{}}\\n\'; sleep 1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const errors: string[] = []
    createRpcClient(child, {
      onNotification() { throw new TypeError('cannot read properties of undefined') },
      onServerRequest() { throw new TypeError('cannot read properties of undefined') },
      onProtocolError: (message) => errors.push(message),
    })
    try {
      await expect.poll(() => errors.length).toBe(2)
      expect(errors.every((m) => /Could not handle Codex message odd\//.test(m))).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })
})
