import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_SPAWN, signalAgent } from '../server/agents/stop.ts'

// A failed proof can quit while the fixture waits for its next numbered browser call.
// EOF must close both the CLI stand-in and its owned waiting worker, without provider usage.
describe('wave 9 browser fixture cleanup', () => {
  it('reaps its background browser worker on EOF', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-wave9-cleanup-'))
    const child = spawn(join(process.cwd(), 'scripts/fixtures/wave9-agent/claude'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    })
    child.stdout.resume(); child.stderr.resume()
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    let succeeded = false
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `session ${root}` }] } }) + '\n')
      let worker: number | undefined
      await expect.poll(() => {
        const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
        worker = rows.map((line) => line.trim().split(/\s+/).map(Number)).find(([, parent]) => parent === child.pid)?.[0]
        return worker !== undefined
      }, { timeout: 5000 }).toBe(true)
      child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture worker kept stdout open after EOF')), 5000) })])
      } finally { clearTimeout(timer) }
      await expect.poll(() => { try { process.kill(worker!, 0); return true } catch { return false } }, { timeout: 5000 }).toBe(false)
      succeeded = true
    } finally {
      if (!succeeded) signalAgent(child, 'SIGTERM') // Only the group this test spawned, even when its parent has exited.
      await closed
    }
  }, 20_000)
})
