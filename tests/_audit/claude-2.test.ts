import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeClaude } from '../../server/agents/claude/capabilities.ts'
import { launchAcp } from '../../server/agents/acp/launch.ts'
import { launchAntigravity } from '../../server/agents/antigravity/launch.ts'
import { launchCodex } from '../../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('claude-2: missing project folder vs missing CLI', () => {
  it('does not claim Claude Code is not installed when only the cwd is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-claude2-'))
    dirs.push(dir)
    // A fake, installed "claude" that prints a minimal valid --help.
    const exe = join(dir, 'claude')
    writeFileSync(exe, '#!/bin/sh\nprintf "Options:\\n  -p, --print  x\\n  --permission-mode <m>  y\\n"\n')
    chmodSync(exe, 0o755)
    // Sanity: the fake works with an existing cwd.
    await expect(probeClaude(exe, dir, process.env, new AbortController().signal)).resolves.toBeTruthy()

    const missingCwd = join(dir, 'moved-away-project')
    const error = await probeClaude(exe, missingCwd, process.env, new AbortController().signal).then(() => undefined, (e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).not.toMatch(/isn't installed or isn't on PATH/)
    expect(error!.message).toContain(missingCwd)
  })

  // Node reports a missing cwd as the same ENOENT as a missing CLI, so each launcher passes its cwd to startErrorMessage.
  const launchers: [string, (cwd: string, executable: string, onEvent: (e: NormalizedEvent) => void) => void][] = [
    ['codex', (cwd, executable, onEvent) => { launchCodex({ cwd }, onEvent, { executable }) }],
    ['antigravity', (cwd, executable, onEvent) => { launchAntigravity({ cwd }, onEvent, { executable }) }],
    ['acp', (cwd, executable, onEvent) => { launchAcp({ agent: 'opencode', label: 'OpenCode', command: executable, args: [], cwd }, onEvent) }],
  ]
  for (const [name, launch] of launchers) {
    it(`${name}: a missing project folder is named, not reported as a missing CLI`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-claude2-'))
      dirs.push(dir)
      const missingCwd = join(dir, 'moved-away-project')
      const events: NormalizedEvent[] = []
      launch(missingCwd, process.execPath, (e) => events.push(e))
      await expect.poll(() => events.some((e) => e.kind === 'exit')).toBe(true)
      const message = (events.find((e) => e.kind === 'error') as { message: string } | undefined)?.message
      expect(message).toContain(missingCwd)
      expect(message).not.toMatch(/isn't installed or isn't on PATH/)
    })

    it(`${name}: a missing CLI in an existing folder still says it is not installed`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-claude2-'))
      dirs.push(dir)
      const events: NormalizedEvent[] = []
      launch(dir, join(dir, 'no-such-cli'), (e) => events.push(e))
      await expect.poll(() => events.some((e) => e.kind === 'exit')).toBe(true)
      expect((events.find((e) => e.kind === 'error') as { message: string } | undefined)?.message).toMatch(/isn't installed or isn't on PATH/)
    })
  }
})
