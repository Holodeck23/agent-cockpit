import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeHelp, validateClaudeArgs } from '../server/agents/claude/capabilities.ts'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'
import { launchClaude } from '../server/agents/claude/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

const help = readFileSync('scripts/fixtures/claude-help.txt', 'utf8')
const installedHelp = readFileSync('tests/fixtures/claude-2.1.291-help.txt', 'utf8')
// macOS scans a freshly written executable on its first run (measured 0.7-1.6 s), so the
// stand-in's first --help can outlast expect.poll's 1 s default. The probe itself allows 5 s.
const FIRST_RUN = { timeout: 5000 }
const legacyHelp = help.replace(/^  --permission-prompts.*\n/m, '')
// 2.1.289 never declares the prompt-file options; it names them only in --bare's prose.
const fileHelp = `${help}  --bare                                Minimal mode. Explicitly provide context
                                        via: --system-prompt[-file],
                                        --append-system-prompt[-file], --add-dir
`
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

const chromeHelp = `${help}  --chrome                              Enable Claude in Chrome integration
`

describe('Use my Chrome (W9-12)', () => {
  it('adds --chrome only when asked, keeping strict MCP wiring', () => {
    const plain = buildClaudeArgs({ cwd: '/p' }, parseClaudeHelp(chromeHelp))
    const chrome = buildClaudeArgs({ cwd: '/p', chrome: true }, parseClaudeHelp(chromeHelp))
    expect(plain).not.toContain('--chrome')
    expect(chrome).toContain('--strict-mcp-config')
    expect(chrome.filter((arg) => arg !== '--chrome')).toEqual(plain)
    validateClaudeArgs(chrome, parseClaudeHelp(chromeHelp))
  })

  it('reads support from the declared option and refuses it where the CLI lacks it', () => {
    expect(parseClaudeHelp(chromeHelp).chrome).toBe(true)
    expect(parseClaudeHelp(help).chrome).toBe(false)
    expect(() => validateClaudeArgs(buildClaudeArgs({ cwd: '/p', chrome: true }), parseClaudeHelp(help))).toThrow(/does not support --chrome/)
  })
})

describe('Claude compatibility', () => {
  it('accepts the effort levels declared by real Claude 2.1.291 help', () => {
    const capabilities = parseClaudeHelp(installedHelp)
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      validateClaudeArgs(buildClaudeArgs({ cwd: '/p', effort }, capabilities), capabilities)
    }
  })
  it('still refuses missing effort levels, unknown formats and choices borrowed from another option', () => {
    const args = buildClaudeArgs({ cwd: '/p', effort: 'high' })
    for (const listing of ['(low, medium, max)', 'See documentation', '(default: high)']) {
      const changed = installedHelp.replace('(low, medium, high, xhigh, max)', listing)
      expect(() => validateClaudeArgs(args, parseClaudeHelp(changed))).toThrow(/--effort high/)
    }
    const moved = installedHelp.replace('(low, medium, high, xhigh, max)', '') + '\n  --other <value> (low, medium, high, xhigh, max)\n'
    expect(() => validateClaudeArgs(args, parseClaudeHelp(moved))).toThrow(/--effort high/)
    const permissions = installedHelp.replace('(choices: "acceptEdits", "auto",', '("acceptEdits", "auto",')
    expect(() => validateClaudeArgs(args, parseClaudeHelp(permissions))).toThrow(/--permission-mode manual/)
  })
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
  it('reads prompt suggestions from the declared option (J2)', () => {
    expect(parseClaudeHelp(help).promptSuggestions).toBe(true)
    expect(parseClaudeHelp(help.replace(/^  --prompt-suggestions.*\n/m, '')).promptSuggestions).toBe(false)
    validateClaudeArgs(buildClaudeArgs({ cwd: '/p' }, parseClaudeHelp(help)), parseClaudeHelp(help))
  })
  it('accepts the prompt file only where the CLI names it (J5)', () => {
    const args = buildClaudeArgs({ cwd: '/p', appendSystemPromptFile: '/tmp/p.md' })
    expect(parseClaudeHelp(fileHelp).appendSystemPromptFile).toBe(true)
    expect(parseClaudeHelp(help).appendSystemPromptFile).toBe(false)
    validateClaudeArgs(args, parseClaudeHelp(fileHelp))
    expect(() => validateClaudeArgs(args, parseClaudeHelp(help))).toThrow(/does not support --append-system-prompt-file/)
  })
  it('hands the appended prompt over in a private file, gone when the agent exits (J5)', async () => {
    const f = fixture(fileHelp), events: NormalizedEvent[] = []
    const prompt = `Conversation so far:\n${'y'.repeat(300_000)}`
    const session = launchClaude({ cwd: f.cwd, appendSystemPrompt: prompt }, (e) => events.push(e), { executable: f.executable })
    let file = ''
    try {
      session.send('hello')
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.ok), FIRST_RUN).toBe(true)
      const launched = readFileSync(join(f.cwd, 'launched'), 'utf8').split('\n')
      expect(launched).not.toContain('--append-system-prompt')
      file = launched[launched.indexOf('--append-system-prompt-file') + 1]!
      expect(readFileSync(file, 'utf8')).toBe(prompt)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally { await session.close() }
    await expect.poll(() => existsSync(file)).toBe(false)
  }, 15_000)
  it('keeps the prompt inline on a CLI without the file option', async () => {
    const f = fixture(help), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd, appendSystemPrompt: 'short guidance' }, (e) => events.push(e), { executable: f.executable })
    try {
      session.send('hello')
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.ok), FIRST_RUN).toBe(true)
      const launched = readFileSync(join(f.cwd, 'launched'), 'utf8').split('\n')
      expect(launched[launched.indexOf('--append-system-prompt') + 1]).toBe('short guidance')
    } finally { await session.close() }
  }, 15_000)
  it.each([help, legacyHelp, installedHelp])('probes the chosen executable, then delivers the queued message', async (text) => {
    const f = fixture(text), events: NormalizedEvent[] = []
    const session = launchClaude({ cwd: f.cwd, effort: 'high' }, (event) => events.push(event), { executable: f.executable })
    try {
      session.send('hello')
      await expect.poll(() => events.some((e) => e.kind === 'result' && e.ok), FIRST_RUN).toBe(true)
      const args = readFileSync(join(f.cwd, 'launched'), 'utf8').split('\n')
      expect(args.includes('--permission-prompts')).toBe(text !== legacyHelp)
      expect(args[args.indexOf('--effort') + 1]).toBe('high')
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
    // The probe gives up after 5 s (capabilities.ts); spawning and the kill add time when the
    // whole suite runs in parallel, which is where a 7 s wait flaked (2026-10-04).
    await expect.poll(() => session.alive(), { timeout: 8500 }).toBe(false)
    await session.close()
    expect(events.some((e) => e.kind === 'error' && /Could not check Claude Code/.test(e.message))).toBe(true)
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1)
    expect(existsSync(join(f.cwd, 'launched'))).toBe(false)
  }, 12_000)
})
