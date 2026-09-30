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

  it('keeps the raw reason for other failures', () => {
    expect(startErrorMessage('claude', spawnError('EACCES', 'spawn claude EACCES'))).toBe(
      'Could not start claude: spawn claude EACCES',
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
