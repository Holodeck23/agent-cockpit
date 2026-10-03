import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeHelp, validateClaudeArgs } from '../server/agents/claude/capabilities.ts'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'
import { launchClaude } from '../server/agents/claude/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

const help = readFileSync('scripts/fixtures/claude-help.txt', 'utf8')
// macOS scans a freshly written executable on its first run (measured 0.7-1.6 s), so the
// stand-in's first --help can outlast expect.poll's 1 s default. The probe itself allows 5 s.
const FIRST_RUN = { timeout: 5000 }
const legacyHelp = help.replace(/^  --permission-prompts.*\n/m, '')
function fixture(helpText = help, probe = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'cockpit-cli-capabilities-'))
  const executable = join(cwd, 'claude')
  writeFileSync(join(cwd, 'help'), helpText)
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--help" ]; then
  ${probe || 'cat help'}
  exit 0
fi
printf '%s\\n' "$@" > launched
printf '{"type":"system","subtype":"init","session_id":"proof-session"}\\n'
while IFS= read -r line; do
  printf '{"type":"result","subtype":"success","is_error":false}\\n'
done
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

describe('Claude compatibility', () => {
  it('keeps host/stdin approvals and changes only the optional flag for legacy CLIs', () => {
    const modern = buildClaudeArgs({ cwd: '/p' }, parseClaudeHelp(help))
    const legacy = buildClaudeArgs({ cwd: '/p' }, parseClaudeHelp(legacyHelp))
    expect(legacy).toEqual(modern.filter((arg) => arg !== '--permission-prompts' && arg !== 'host'))
    expect(legacy).toContain('manual')
    expect(legacy).toContain('--permission-prompt-tool')
    expect(legacy).toContain('stdio')
    validateClaudeArgs(legacy, parseClaudeHelp(legacyHelp))
  })
  it('ignores option names mentioned in wrapped help prose', () => {
    const wrapped = legacyHelp.replace('Usage: claude [options]', 'Usage: claude [options]\n                                        --permission-prompts is not available')
    expect(parseClaudeHelp(wrapped).permissionPrompts).toBe(false)
  })
  it('refuses missing launch options and unsupported selected modes/effort', () => {
    const args = buildClaudeArgs({ cwd: '/p', effort: 'max' })
    for (const option of ['--strict-mcp-config', '--settings', '--include-partial-messages', '--effort']) {
      const absent = help.split('\n').filter((line) => !line.startsWith(`  ${option}`)).join('\n')
      expect(() => validateClaudeArgs(args, parseClaudeHelp(absent))).toThrow(/does not support/)
    }
    expect(() => validateClaudeArgs(args, parseClaudeHelp(help.replace('"max"', '"medium"')))).toThrow(/--effort max/)
    expect(() => validateClaudeArgs(args, parseClaudeHelp(help.replace('"manual"', '"default"')))).toThrow(/--permission-mode manual/)
  })
  it.each([help, legacyHelp])('probes the chosen executable, then delivers the queued message', async (text) => {
    const f = fixture(text), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd }, (event) => events.push(event), { executable: f.executable })
    try {
      session.send('hello')
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.ok), FIRST_RUN).toBe(true)
      expect(readFileSync(join(f.cwd, 'launched'), 'utf8').includes('--permission-prompts')).toBe(text === help)
    } finally { await session.close() }
  })
  it('fails closed, preserves no fake session, and re-probes on retry after CLI changes', async () => {
    const f = fixture('not Claude help'), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd }, (e) => events.push(e), { executable: f.executable })
    session.send('hello')
    await expect.poll(() => session.alive(), FIRST_RUN).toBe(false)
    expect(existsSync(join(f.cwd, 'launched'))).toBe(false)
    expect(events.filter((e) => e.kind === 'session')).toEqual([])
    expect(events.filter((e) => e.kind === 'result')).toEqual([{ kind: 'result', ok: false }])
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1)
    await session.close()
    writeFileSync(join(f.cwd, 'help'), legacyHelp)
    const retry = launchClaude({ cwd: f.cwd }, (e) => events.push(e), { executable: f.executable })
    try {
      retry.send('retry')
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.ok), FIRST_RUN).toBe(true)
    } finally { await retry.close() }
  })
  it.each(['interrupt', 'close'] as const)('cancels a running probe on %s without launching or late errors', async (action) => {
    const f = fixture(help, 'echo started > probing; exec sleep 30'), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd }, (e) => events.push(e), { executable: f.executable })
    session.send('must never reach provider')
    await expect.poll(() => existsSync(join(f.cwd, 'probing')), FIRST_RUN).toBe(true)
    await session[action]()
    await session.close()
    expect(session.alive()).toBe(false)
    expect(existsSync(join(f.cwd, 'launched'))).toBe(false)
    expect(events).toEqual([{ kind: 'result', ok: false, stopped: true }, { kind: 'exit', code: null }])
  })
  it.each(['exit 3', 'yes oversized', 'exec sleep 30'])('bounds failed or excessive probes: %s', async (probe) => {
    const f = fixture(help, probe), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd }, (e) => events.push(e), { executable: f.executable })
    session.send('hello')
    await expect.poll(() => session.alive(), { timeout: 7000 }).toBe(false)
    await session.close()
    expect(events.some((e) => e.kind === 'error' && /Could not check Claude Code/.test(e.message))).toBe(true)
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1)
    expect(existsSync(join(f.cwd, 'launched'))).toBe(false)
  }, 9000)
})
