import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchCodex } from '../server/agents/codex/launch.ts'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import { launchAcp } from '../server/agents/acp/launch.ts'
import { describe, expect, it } from 'vitest'
import { launchClaude } from '../server/agents/claude/launch.ts'
import { startErrorMessage } from '../server/agents/start-error.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

function spawnError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('startErrorMessage', () => {
  it('explains a missing Claude Code CLI', () => {
    expect(startErrorMessage('claude', spawnError('ENOENT', 'spawn claude ENOENT'))).toBe(
      "Claude Code isn't installed or isn't on PATH. Install it and sign in, then restart Cockpit.",
    )
  })

  it('explains a missing Codex CLI', () => {
    expect(startErrorMessage('codex', spawnError('ENOENT', 'spawn codex ENOENT'))).toBe(
      "Codex isn't installed or isn't on PATH. Install it and sign in, then restart Cockpit.",
    )
  })

  it('explains a missing Antigravity CLI', () => {
    expect(startErrorMessage('antigravity', spawnError('ENOENT', 'spawn agy ENOENT'))).toBe(
      "Antigravity isn't installed or isn't on PATH. Install it and sign in, then restart Cockpit.",
    )
  })

  it('keeps the raw reason for other failures', () => {
    expect(startErrorMessage('claude', spawnError('EIO', 'spawn claude EIO'))).toBe(
      'Could not start claude: spawn claude EIO',
    )
  })
})

describe('launchClaude with a missing executable', () => {
  it('reports the friendly message', async () => {
    const events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: process.cwd() }, (event) => events.push(event), {
      executable: '/nonexistent/cockpit-test/claude',
    })
    for (let i = 0; i < 50 && !events.some((e) => e.kind === 'error'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(events).toContainEqual({
      kind: 'error',
      message: "Claude Code isn't installed or isn't on PATH. Install it and sign in, then restart Cockpit.",
    })
    await session.close()
  })
})

const launchers = {
  claude: (executable: string, sink: (e: NormalizedEvent) => void) => launchClaude({ cwd: process.cwd() }, sink, { executable }),
  codex: (executable: string, sink: (e: NormalizedEvent) => void) => launchCodex({ cwd: process.cwd() }, sink, { executable }),
  antigravity: (executable: string, sink: (e: NormalizedEvent) => void) => launchAntigravity({ cwd: process.cwd() }, sink, { executable }),
  opencode: (executable: string, sink: (e: NormalizedEvent) => void) => launchAcp({ agent: 'opencode', label: 'OpenCode', command: executable, args: [], cwd: process.cwd() }, sink),
}
for (const [agent, launch] of Object.entries(launchers)) {
  it(`${agent} can close before a failed spawn is delivered`, async () => {
    const session = launch('/nonexistent/cockpit-test/cli', () => {})
    await session.close()
    expect(session.alive()).toBe(false)
  })
  for (const failure of ['missing', 'non-executable']) {
    it(`${agent} completes a ${failure} launch exactly once`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cockpit-start-error-'))
      const executable = join(dir, 'cli')
      if (failure === 'non-executable') { writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o600) }
      const events: NormalizedEvent[] = []
      const session = launch(executable, (event) => events.push(event))
      session.send('hello')
      await expect.poll(() => events.filter((e) => e.kind === 'exit').length).toBe(1)
      await session.close()
      // Allow close and any rejected initialization RPCs to settle too.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(session.alive()).toBe(false)
      expect(events.filter((e) => e.kind === 'result')).toEqual([{ kind: 'result', ok: false }])
      expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1)
      expect(events.filter((e) => e.kind === 'session')).toEqual([])
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(failure === 'missing' ? /Install it/ : /executable permissions/) })
    })
  }
}
