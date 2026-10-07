import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../server/agents/capabilities/service.ts'
import { detectManager } from '../server/agents/capabilities/manager.ts'
import { resolveExecutable } from '../server/agents/capabilities/resolve.ts'

// F-CLI: real stand-in executables on a private PATH, so lookup, stat, spawn and timeouts are real.
// Every run appends its arguments to `calls`, which is how "no probe ran" is proved.
const help = `${readFileSync('scripts/fixtures/claude-help.txt', 'utf8')}  --chrome                              Enable Claude in Chrome integration\n`
// macOS scans a freshly written executable on its first run (up to ~1.6 s).
const SLOW = { timeout: 20_000 }

function bin(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  // Written beside and renamed in, as an installer replaces a binary: a new inode, never a half-written file.
  writeFileSync(`${file}.tmp`, `#!/bin/sh\necho "$@" >> "${join(dir, 'calls')}"\n${body}\n`)
  chmodSync(`${file}.tmp`, 0o755)
  renameSync(`${file}.tmp`, file)
  return file
}
const calls = (dir: string): string[] => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []

function claudeBin(dir: string, version = '2.1.291 (Claude Code)', helpText = help, auth = '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}', authExit = 0): string {
  writeFileSync(join(dir, 'help.txt'), helpText)
  return bin(dir, 'claude', `case "$1" in
--version) echo "${version}" ;;
--help) cat "${join(dir, 'help.txt')}" ;;
auth) echo '${auth}'; exit ${authExit} ;;
*) echo "unexpected $*" >&2; exit 9 ;;
esac`)
}

const AGY_MODELS = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n'
function agyBin(dir: string, models = `printf '${AGY_MODELS.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`): string {
  return bin(dir, 'agy', `case "$1" in
--version) echo "1.3.0" ;;
models) ${models} ;;
*) echo "unexpected $*" >&2; exit 9 ;;
esac`)
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-capabilities-'))
  const dir = join(root, 'bin')
  mkdirSync(dir)
  let path = dir
  let clock = Date.parse('2026-10-06T10:00:00.000Z')
  const service = createCapabilityService({ pathEnv: () => path, now: () => clock, home: root, timeoutMs: 6000 })
  return { root, dir, service, setPath: (next: string) => { path = next }, advance: (ms: number) => { clock += ms } }
}

describe('capability probes (W10-01)', () => {
  it('reports a missing executable without running anything', async () => {
    const { service } = setup()
    const caps = await service.get('codex')
    expect(caps.executable).toEqual({ state: 'missing', reason: 'codex is not installed or not on the PATH Cockpit uses' })
    expect(caps.models.state).toBe('not_checked')
    expect(caps.auth.state).toBe('not_checked')
  })

  it('reads Claude Code flags from declarations and sign-in from auth status, without a turn', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir)
    const caps = await service.get('claude')
    expect(caps.executable).toMatchObject({ state: 'found', identity: { command: 'claude', path: join(dir, 'claude'), version: '2.1.291 (Claude Code)' } })
    expect(caps.settings.permissionMode?.state).toBe('supported')
    expect(caps.settings.chrome?.state).toBe('supported')
    expect(caps.auth).toMatchObject({ state: 'signed_in', detail: 'claude.ai · max' })
    expect(caps.probedAt).toBe('2026-10-06T10:00:00.000Z')
    // Only non-generating commands ran.
    expect(calls(dir).sort()).toEqual(['--help', '--version', 'auth status --json'])
  })

  it('marks a flag missing from --help unsupported, and malformed help unavailable rather than unsupported', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir, '2.1.291 (Claude Code)', help.replace(/^ {2}--chrome.*\n/m, ''))
    expect((await service.get('claude')).settings.chrome?.state).toBe('unsupported')
    claudeBin(dir, '2.1.292 (Claude Code)', 'Usage: something else entirely\n')
    const caps = await service.get('claude', { refresh: true })
    expect(caps.executable.state).toBe('found')
    expect(caps.settings.chrome).toMatchObject({ state: 'unavailable' })
    expect(caps.settings.chrome?.reason).toMatch(/Could not read Claude Code capabilities/)
  })

  it('says signed out only when the CLI says so, and unknown otherwise', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir, '2.1.291 (Claude Code)', help, '{"loggedIn": false}', 1)
    expect((await service.get('claude')).auth.state).toBe('signed_out')
    claudeBin(dir, '2.1.293 (Claude Code)', help, 'Error: network unreachable', 2)
    expect((await service.get('claude', { refresh: true })).auth).toMatchObject({ state: 'unknown' })
  })

  it('treats a --version that times out as unavailable, never as not installed', SLOW, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-capabilities-'))
    const dir = join(root, 'bin')
    bin(dir, 'codex', 'sleep 30')
    const service = createCapabilityService({ pathEnv: () => dir, home: root, timeoutMs: 2500 })
    const caps = await service.get('codex')
    expect(caps.executable).toMatchObject({ state: 'unavailable', identity: { path: join(dir, 'codex') } })
    if (caps.executable.state === 'unavailable') expect(caps.executable.reason).toMatch(/timed out/)
  })
})

describe('capability cache (W10-02)', () => {
  it('reuses a probe for the same executable for up to a minute, then probes again', SLOW, async () => {
    const { dir, service, advance } = setup()
    claudeBin(dir)
    await service.get('claude')
    await service.get('claude')
    expect(calls(dir)).toHaveLength(3)
    advance(61_000)
    await service.get('claude')
    expect(calls(dir)).toHaveLength(6)
  })

  it('probes again at once when the executable is replaced in place (a self-update)', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir, '2.1.289 (Claude Code)')
    expect((await service.get('claude')).executable).toMatchObject({ identity: { version: '2.1.289 (Claude Code)' } })
    claudeBin(dir, '2.1.291 (Claude Code)', help.replace(/^ {2}--chrome.*\n/m, ''))
    const caps = await service.get('claude')
    expect(caps.executable).toMatchObject({ identity: { version: '2.1.291 (Claude Code)' } })
    // Nothing from the old executable survives: its --chrome support is gone with it.
    expect(caps.settings.chrome?.state).toBe('unsupported')
  })

  it('follows a PATH change to a different executable and never reports the old one', SLOW, async () => {
    const { root, dir, service, setPath } = setup()
    claudeBin(dir, '2.1.289 (Claude Code)')
    await service.get('claude')
    const other = join(root, 'other')
    mkdirSync(other)
    claudeBin(other, '9.9.9 (Claude Code)', help, '{"loggedIn": false}', 1)
    setPath(`${other}:${dir}`)
    const caps = await service.get('claude')
    expect(caps.executable).toMatchObject({ identity: { path: join(other, 'claude'), version: '9.9.9 (Claude Code)' } })
    expect(caps.auth.state).toBe('signed_out')
  })

  it('keeps account contexts apart', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir)
    const a = await service.get('claude')
    const b = await service.get('claude', { context: 'profile-b' })
    expect(a.context).toBe('default')
    expect(b.context).toBe('profile-b')
    expect(calls(dir)).toHaveLength(6)
  })

  it('Refresh probes again, and a failed probe does not fall back to an earlier result', SLOW, async () => {
    const { dir, service } = setup()
    agyBin(dir)
    expect((await service.get('antigravity', { refresh: true })).models.state).toBe('supported')
    // Same file, but agy can no longer reach its service: the earlier model list is not shown as current.
    agyBin(dir, `echo "Error: dial tcp: lookup cloudcode-pa.googleapis.com: no such host" >&2; exit 1`)
    const caps = await service.get('antigravity', { refresh: true })
    expect(caps.models.state).toBe('unavailable')
    expect(caps.models.value).toBeUndefined()
    expect(caps.auth.state).toBe('unknown')
  })

  it('runs one probe for concurrent requests', SLOW, async () => {
    const { dir, service } = setup()
    claudeBin(dir)
    await Promise.all([service.get('claude'), service.get('claude'), service.get('claude')])
    expect(calls(dir)).toHaveLength(3)
  })
})

describe('Antigravity probing (W10-01, W10-03)', () => {
  it('never runs agy just to show the picker: it can start its own updater', async () => {
    const { dir, service } = setup()
    agyBin(dir)
    const caps = await service.get('antigravity')
    expect(caps.executable).toMatchObject({ state: 'found', identity: { path: join(dir, 'agy') } })
    if (caps.executable.state === 'found') expect(caps.executable.identity.version).toBeUndefined()
    expect(caps.models.state).toBe('not_checked')
    expect(calls(dir)).toEqual([])
  })

  it('lists the models agy reports, and signed out from its own message', SLOW, async () => {
    const { dir, service } = setup()
    agyBin(dir)
    const caps = await service.get('antigravity', { refresh: true })
    expect(caps.models).toMatchObject({ state: 'supported', source: 'agy models', value: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
    ] })
    expect(caps.auth.state).toBe('signed_in')
    agyBin(dir, `echo "Please sign in to view available models. Launch the CLI without arguments to sign in." >&2; exit 1`)
    const out = await service.get('antigravity', { refresh: true })
    expect(out.auth.state).toBe('signed_out')
    expect(out.models).toMatchObject({ state: 'unavailable' })
  })

  it('keeps the last agy check after a minute, labelled stale, instead of running agy again', SLOW, async () => {
    const { dir, service, advance } = setup()
    agyBin(dir)
    await service.get('antigravity', { refresh: true })
    advance(120_000)
    const caps = await service.get('antigravity')
    expect(caps.stale).toBe(true)
    expect(caps.models.state).toBe('supported')
    expect(calls(dir)).toHaveLength(2)
  })

  it('checks agy for a launch: reuses a check under a minute old, otherwise runs it again', SLOW, async () => {
    const { dir, service, advance } = setup()
    agyBin(dir)
    expect((await service.get('antigravity', { purpose: 'launch' })).models.state).toBe('supported')
    expect(calls(dir)).toHaveLength(2)
    await service.get('antigravity', { purpose: 'launch' })
    expect(calls(dir)).toHaveLength(2)
    advance(61_000)
    const caps = await service.get('antigravity', { purpose: 'launch' })
    expect(caps.stale).toBeUndefined()
    expect(calls(dir)).toHaveLength(4)
  })

  it('does not keep a result when agy replaced itself while being checked', SLOW, async () => {
    const { dir, service } = setup()
    // The stand-in "updates" itself during `models`, as agy's background updater does.
    agyBin(dir, `printf 'm-1\\tOne\\n'; cp "$0" "$0.new"; echo '# updated' >> "$0.new"; mv "$0.new" "$0"`)
    const caps = await service.get('antigravity', { refresh: true })
    expect(caps.changedDuringProbe).toBe(true)
    expect((await service.get('antigravity')).models.state).toBe('not_checked')
  })
})

describe('executable identity', () => {
  it('resolves the first PATH hit and its real path', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-resolve-'))
    const a = join(root, 'a')
    const b = join(root, 'b')
    bin(b, 'codex', 'true')
    mkdirSync(a)
    writeFileSync(join(a, 'codex'), 'not executable')
    const found = resolveExecutable('codex', `${a}:${b}`)
    expect(found?.path).toBe(join(b, 'codex'))
    expect(found?.fingerprint).toContain(found?.realpath)
    expect(resolveExecutable('codex', a)).toBeUndefined()
  })

  it('names the install manager from the resolved path, never the command name', () => {
    const home = '/Users/someone'
    expect(detectManager('claude', `${home}/.local/share/claude/versions/2.1.291`, home).kind).toBe('native')
    expect(detectManager('claude', `${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, home).kind).toBe('npm')
    expect(detectManager('claude', '/opt/homebrew/Caskroom/claude-code/2.1.291/claude', home).kind).toBe('homebrew')
    expect(detectManager('codex', '/opt/homebrew/Caskroom/codex/0.160.1/bin/codex', home).kind).toBe('homebrew')
    expect(detectManager('codex', `${home}/.codex/packages/standalone/0.160.1/bin/codex`, home).kind).toBe('standalone')
    expect(detectManager('codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', home).kind).toBe('npm')
    expect(detectManager('antigravity', `${home}/.local/bin/agy`, home).kind).toBe('native')
    expect(detectManager('antigravity', '/usr/local/bin/agy', home).kind).toBe('unknown')
    expect(detectManager('opencode', '/somewhere/opencode', home).kind).toBe('unknown')
  })
})
