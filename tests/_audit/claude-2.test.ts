import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeClaude } from '../../server/agents/claude/capabilities.ts'

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
})
