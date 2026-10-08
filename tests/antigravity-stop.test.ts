import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

// Like agy 1.3.1 on Stop (dogfood 10-08): it starts a shell command, and on SIGINT reports its own
// "interrupted" result, writes "error: interrupted" to stderr and exits 1. The command is in agy's group.
const STAND_IN = `#!/bin/sh
dir=$(dirname "$0")
trap 'printf "%s\\n" "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"c\\",\\"status\\":\\"ERROR\\",\\"response\\":\\"interrupted\\"}}"; echo "error: interrupted" >&2; exit 1' INT
printf '%s\\n' '{"event":"init","conversation_id":"c","init":{"model":"m","cwd":"/p"}}'
read -r _line
sleep 30 &
echo $! > "$dir/child.pid"
wait
`

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('Stop on an Antigravity turn', () => {
  it('ends it as stopped, not failed: agy\'s own "interrupted" and its stderr are not a failure, and its command goes too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-stop-'))
    const executable = join(dir, 'agy')
    writeFileSync(executable, STAND_IN)
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const exited = new Promise<void>((resolve) => {
      const session = launchAntigravity({ cwd: dir }, (event) => {
        events.push(event)
        if (event.kind === 'exit') resolve()
      }, { executable })
      session.send('Run sleep 30')
      setTimeout(() => session.interrupt(), 500)
    })
    await exited
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toEqual([{ kind: 'result', ok: false, stopped: true }])
    expect(events.filter((e) => e.kind === 'error')).toEqual([])
    const child = Number((await import('node:fs')).readFileSync(join(dir, 'child.pid'), 'utf8'))
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(child)).toBe(false)
  }, 15_000)
})
