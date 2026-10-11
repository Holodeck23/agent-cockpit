import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchClaude } from '../../server/agents/claude/launch.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'

describe('claude-1: messages sent while Claude Code is still starting', () => {
  it('delivers every message sent before the --help probe resolves, in order', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-audit-claude1-'))
    const executable = join(cwd, 'claude')
    const received = join(cwd, 'stdin.log')
    writeFileSync(join(cwd, 'help'), readFileSync('scripts/fixtures/claude-help.txt', 'utf8'))
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--help" ]; then sleep 0.3; cat help; exit 0; fi
printf '{"type":"system","subtype":"init","session_id":"audit-claude-1"}\\n'
while IFS= read -r line; do printf '%s\\n' "$line" >> "${received}"; done
`)
    chmodSync(executable, 0o755)
    const events: NormalizedEvent[] = []
    const session = launchClaude({ cwd }, (event) => events.push(event), { executable })
    try {
      // Both sends land before the probe resolves (session not yet spawned).
      session.send('do X')
      session.send('also do Y')
      await expect.poll(() => events.some((e) => e.kind === 'session'), { timeout: 5000 }).toBe(true)
      await expect.poll(() => existsSync(received) ? readFileSync(received, 'utf8').split('\n').filter(Boolean).length : 0, { timeout: 3000 }).toBe(2)
      const lines = readFileSync(received, 'utf8').split('\n').filter(Boolean)
      expect(lines[0]).toContain('do X')
      expect(lines[1]).toContain('also do Y')
      expect(events.some((e) => e.kind === 'error' && /still starting/.test(e.message))).toBe(false)
    } finally { await session.close() }
  }, 15000)
})
