import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../server/agents/capabilities/service.ts'
import { createLifecycle, type LifecycleOptions, type OperationView } from '../server/agents/lifecycle/service.ts'
import { updatePlanFor } from '../server/agents/lifecycle/plans.ts'
import { redactSecrets } from '../server/agents/lifecycle/redact.ts'

// F-CLI for install/update/sign-in (W10-05, W10-06, W10-09): stand-in installers and CLIs in a
// throwaway HOME. Real processes, real process groups, real files; no network, no real CLI.
const SLOW = { timeout: 30_000 }
const HELP = '  --print\n  --permission-mode <mode>  (choices: "default", "plan")\n'

function cliScript(version: string, help = HELP, extra = ''): string {
  return `#!/bin/sh
case "$1" in
${extra}
--version) echo "${version}" ;;
--help) printf '${help.replace(/\n/g, '\\n')}' ;;
auth) echo '{"loggedIn": false}'; exit 1 ;;
*) exit 0 ;;
esac
`
}

function setup(installers: Record<string, string> = {}, extra: Partial<LifecycleOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-lifecycle-'))
  const home = join(root, 'home')
  const sys = join(root, 'sys')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(sys)
  writeFileSync(join(home, '.zshrc'), '# untouched\n')
  const scripts = new Map(Object.entries(installers).map(([url, body]) => [url, Buffer.from(body)]))
  const table = Object.fromEntries([...scripts].map(([url, bytes]) => [url, createHash('sha256').update(bytes).digest('hex')]))
  const pathEnv = (): string => `${sys}:${home}/.local/bin`
  const capabilities = createCapabilityService({ pathEnv, home, timeoutMs: 8000 })
  const lifecycle = createLifecycle({
    stateRoot: join(root, 'state'), home, capabilities, pathEnv,
    download: async (url) => { const bytes = scripts.get(url); if (!bytes) throw new Error('offline'); return bytes },
    installers: { claude: { url: 'https://claude.ai/install.sh', sha256: table['https://claude.ai/install.sh'] ?? '0'.repeat(64), args: [] } },
    ...extra,
  })
  return { root, home, sys, lifecycle }
}

const finished = async (lifecycle: ReturnType<typeof createLifecycle>, id: string): Promise<OperationView> => {
  await expect.poll(() => lifecycle.get(id)?.endedAt !== undefined, { timeout: 25_000, interval: 50 }).toBe(true)
  return lifecycle.get(id)!
}

// A stand-in for the official installer: writes only $HOME/.local/bin/claude, and edits the shell
// profile only when ~/.local/bin is not on its PATH, as the real Codex and agy installers do.
const INSTALLER = `#!/bin/bash
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc" ;; esac
echo "Downloading Claude Code 2.1.291..."
cat > "$HOME/.local/bin/claude" <<'EOF'
${cliScript('2.1.291 (Claude Code)')}EOF
chmod +x "$HOME/.local/bin/claude"
echo "Installed"
`

describe('install (W10-05)', () => {
  it('shows what will happen before anything runs', SLOW, async () => {
    const { lifecycle, home } = setup({ 'https://claude.ai/install.sh': INSTALLER })
    const plan = await lifecycle.plan('claude', 'install')
    expect(plan).toMatchObject({ available: true, destination: join(home, '.local', 'bin', 'claude') })
    if (plan.available) expect(plan.interaction).toMatch(/prints nothing/)
    expect(readdirSync(join(home, '.local', 'bin'))).toEqual([])
  })

  it('installs into the home folder with the reviewed script, leaves the shell profile alone, and rechecks', SLOW, async () => {
    const { lifecycle, home } = setup({ 'https://claude.ai/install.sh': INSTALLER })
    const op = await finished(lifecycle, (await lifecycle.start('claude', 'install')).id)
    expect(op).toMatchObject({ state: 'auth_needed', result: { path: join(home, '.local', 'bin', 'claude'), version: '2.1.291 (Claude Code)' } })
    expect(op.lines.join('\n')).toContain('Installed')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('# untouched\n')
    expect(readFileSync(op.logFile, 'utf8')).toContain('sha256 ')
  })

  it('refuses an installer whose bytes differ from the reviewed ones, and gives the manual command', SLOW, async () => {
    const { lifecycle, home } = setup({ 'https://claude.ai/install.sh': INSTALLER }, {
      installers: { claude: { url: 'https://claude.ai/install.sh', sha256: 'f'.repeat(64), args: [] } },
    })
    const op = await finished(lifecycle, (await lifecycle.start('claude', 'install')).id)
    expect(op.state).toBe('error')
    expect(op.manual).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(existsSync(join(home, '.local', 'bin', 'claude'))).toBe(false)
  })

  it('never installs a second copy beside an existing one, whatever installed it', SLOW, async () => {
    const { lifecycle, sys } = setup({ 'https://claude.ai/install.sh': INSTALLER })
    writeFileSync(join(sys, 'claude'), cliScript('2.1.200 (Claude Code)'))
    chmodSync(join(sys, 'claude'), 0o755)
    const plan = await lifecycle.plan('claude', 'install')
    expect(plan).toMatchObject({ available: false })
    if (!plan.available) expect(plan.reason).toMatch(/already installed at .*claude/)
    await expect(lifecycle.start('claude', 'install')).rejects.toThrow(/already installed/)
  })

  it('offers OpenCode no guided install, only the manual route', SLOW, async () => {
    const { lifecycle } = setup()
    expect(await lifecycle.plan('opencode', 'install')).toMatchObject({ available: false, manual: expect.stringContaining('opencode') })
  })

  it('cancels the whole installer process group and reports what is actually there', SLOW, async () => {
    const pids = mkdtempSync(join(tmpdir(), 'cockpit-lifecycle-pids-'))
    const { lifecycle } = setup({ 'https://claude.ai/install.sh': `#!/bin/bash\n(sleep 60; echo late > "${join(pids, 'survivor')}") &\necho $! > "${join(pids, 'child.pid')}"\necho "Downloading..."\nsleep 60\n` })
    const { id } = await lifecycle.start('claude', 'install')
    await expect.poll(() => lifecycle.get(id)?.lines.includes('Downloading...'), { timeout: 10_000 }).toBe(true)
    lifecycle.cancel(id)
    const op = await finished(lifecycle, id)
    expect(op.state).toBe('cancelled')
    expect(op.message).toMatch(/not installed/)
    const pid = Number(readFileSync(join(pids, 'child.pid'), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe('update outcomes (W10-09)', () => {
  function installed(version: string, updater: string) {
    const ctx = setup()
    writeFileSync(join(ctx.home, '.local', 'bin', 'agy'), cliScript(version, HELP, `update) ${updater} ;;\nmodels) printf 'm\\tM\\n' ;;`))
    chmodSync(join(ctx.home, '.local', 'bin', 'agy'), 0o755)
    return ctx
  }

  it('reports the new version after a successful update', SLOW, async () => {
    const ctx = installed('1.2.16', `cp "$0" "$0.new"; sed -i '' 's/1.2.16/1.3.0/' "$0.new"; mv "$0.new" "$0"; echo "Updated to 1.3.0"`)
    const op = await finished(ctx.lifecycle, (await ctx.lifecycle.start('antigravity', 'update')).id)
    expect(op).toMatchObject({ state: 'updated', result: { version: '1.3.0', previousVersion: '1.2.16' } })
  })

  it('an updater that dies halfway: reports what is there now, keeps its log, claims no rollback', SLOW, async () => {
    const ctx = installed('1.2.16', `rm "$0"; echo "extracting failed" >&2; exit 3`)
    const op = await finished(ctx.lifecycle, (await ctx.lifecycle.start('antigravity', 'update')).id)
    expect(op.state).toBe('error')
    expect(op.message).toMatch(/exited with 3/)
    expect(op.message).toMatch(/now not installed/)
    expect(op.message).not.toMatch(/roll(ed)? ?back/i)
    expect(readFileSync(op.logFile, 'utf8')).toContain('extracting failed')
    expect(op.manual).toContain('antigravity.google/cli/install.sh')
  })

  it('an update that installs an incompatible CLI says so', SLOW, async () => {
    const { lifecycle, home } = setup()
    const exe = join(home, '.local', 'share', 'claude', 'versions', '2.1.300')
    mkdirSync(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true })
    writeFileSync(exe, cliScript('2.1.300 (Claude Code)', HELP, `update) cp "$0" "$0.new"; sed -i '' 's/--permission-mode/--other-mode/; s/2.1.300/2.1.301/' "$0.new"; mv "$0.new" "$0" ;;`))
    chmodSync(exe, 0o755)
    const { symlinkSync } = await import('node:fs')
    symlinkSync(exe, join(home, '.local', 'bin', 'claude'))
    const op = await finished(lifecycle, (await lifecycle.start('claude', 'update')).id)
    expect(op).toMatchObject({ state: 'incompatible', result: { version: '2.1.301 (Claude Code)' } })
    expect(op.message).toMatch(/does not support what Cockpit needs/)
  })
})

describe('update plans: manager, no sudo, no second copy (W10-05)', () => {
  const caps = (agent: 'claude' | 'codex' | 'antigravity' | 'opencode', realpath: string, kind: 'native' | 'npm' | 'homebrew' | 'standalone' | 'unknown') => ({
    agent, context: 'default', settings: {}, auth: { state: 'not_checked' as const }, models: { state: 'not_checked' as const },
    manager: { kind, label: kind },
    executable: { state: 'found' as const, identity: { command: agent, path: realpath, realpath, fingerprint: 'f', version: '1' } },
  })

  it('updates Homebrew installs through Homebrew without cleanup or autoremove', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-brew-'))
    const cask = join(root, 'Caskroom', 'claude-code', '2.1.291')
    mkdirSync(cask, { recursive: true })
    const plan = updatePlanFor(caps('claude', join(cask, 'claude'), 'homebrew'), { brew: join(root, 'bin', 'brew') })
    expect(plan).toMatchObject({ available: true, executable: join(root, 'bin', 'brew'), args: ['upgrade', '--cask', 'claude-code'],
      env: { HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_AUTOREMOVE: '1' } })
    mkdirSync(join(root, 'Caskroom', 'codex', '0.1'), { recursive: true })
    const codex = updatePlanFor(caps('codex', join(root, 'Caskroom', 'codex', '0.1', 'codex'), 'homebrew'), { brew: join(root, 'bin', 'brew') })
    expect(codex).toMatchObject({ available: true, args: ['update'], env: { HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_AUTOREMOVE: '1' } })
  })

  it('gives the exact manual command when Homebrew’s folder is not writable (admin-only) or the installer is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-brew-ro-'))
    const caskroom = join(root, 'Caskroom', 'claude-code', '2.1.291')
    mkdirSync(caskroom, { recursive: true })
    chmodSync(join(root, 'Caskroom', 'claude-code'), 0o555)
    try {
      expect(updatePlanFor(caps('claude', join(caskroom, 'claude'), 'homebrew'), { brew: '/opt/homebrew/bin/brew' }))
        .toMatchObject({ available: false, manual: 'brew upgrade --cask claude-code' })
    } finally { chmodSync(join(root, 'Caskroom', 'claude-code'), 0o755) }
    expect(updatePlanFor(caps('opencode', '/somewhere/opencode', 'unknown'), {})).toMatchObject({ available: false, manual: expect.stringContaining('opencode upgrade') })
  })

  it('never plans sudo', () => {
    for (const [agent, path, kind] of [['claude', '/x/claude', 'native'], ['claude', '/x/node_modules/@anthropic-ai/claude-code/cli', 'npm'], ['codex', '/x/codex', 'standalone'], ['antigravity', '/x/agy', 'native']] as const) {
      const plan = updatePlanFor(caps(agent, path, kind), {})
      const commands = plan.available ? [plan.executable, ...plan.args] : [plan.manual ?? '']
      expect(commands.join(' ')).not.toMatch(/\bsudo\b/)
    }
  })
})

describe('secrets in lifecycle output (W10-06)', () => {
  it('redacts token shapes and never logs what the user typed', SLOW, async () => {
    const { lifecycle, home } = setup()
    writeFileSync(join(home, '.local', 'bin', 'claude'), cliScript('2.1.291 (Claude Code)', HELP, `auth) if [ "$2" = "login" ]; then echo "Visit https://claude.ai/oauth/authorize?code=true&state=abc"; echo "token sk-ant-oat01-SECRETMARKER1 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJNQVJLRVIifQ.c2lnbmF0dXJlTUFSS0VS"; read code; echo "got it"; exit 0; fi; echo '{"loggedIn": false}'; exit 1 ;;`))
    chmodSync(join(home, '.local', 'bin', 'claude'), 0o755)
    const { id } = await lifecycle.start('claude', 'signin')
    await expect.poll(() => lifecycle.get(id)?.lines.some((l) => l.includes('Visit')), { timeout: 10_000 }).toBe(true)
    lifecycle.write(id, 'PASTED-CODE-MARKER\n')
    const op = await finished(lifecycle, id)
    const everything = `${op.lines.join('\n')}\n${readFileSync(op.logFile, 'utf8')}\n${JSON.stringify(op)}`
    expect(everything).not.toMatch(/SECRETMARKER1|PASTED-CODE-MARKER|eyJzdWIi/)
    expect(everything).toContain('https://claude.ai/oauth/authorize')
    // The CLI still says signed out, so sign-in is not claimed.
    expect(op.state).toBe('unknown')
  })

  it('redacts the shapes it claims to', () => {
    expect(redactSecrets('a sk-ant-api03-abcDEF_123-x b')).toBe('a <secret> b')
    expect(redactSecrets('{"access_token":"ya29.verylongvalue","x":1}')).toBe('{"access_token":"<secret>","x":1}')
    expect(redactSecrets('me@example.com')).toBe('<email>')
    expect(redactSecrets('\u001b[32mok\u001b[0m')).toBe('ok')
  })
})
