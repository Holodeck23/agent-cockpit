import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../../server/agents/capabilities/service.ts'
import { createLifecycle } from '../../server/agents/lifecycle/service.ts'

// u05-3: when a Homebrew-cask update fails, updateCli (server/agents/lifecycle/service.ts:266) always
// sets `manual` to `<agent> update`, although the plan that actually ran was
// `brew upgrade --cask claude-code` (plans.ts:68,73). The UI then says
// "Run it yourself in Terminal, then Refresh: claude update".
// CORRECT behaviour: the manual command shown after a failed cask update is the brew command.

const HELP = '  --print\n  --permission-mode <mode>  (choices: "default", "plan")\n'
const cli = `#!/bin/sh
case "$1" in
--version) echo "2.1.291 (Claude Code)" ;;
--help) printf '${HELP.replace(/\n/g, '\\n')}' ;;
auth) echo '{"loggedIn": false}'; exit 1 ;;
*) exit 0 ;;
esac
`

describe('u05-3: failed Homebrew-cask update names the command that owns the install', () => {
  it('shows the brew command, not `claude update`, when brew upgrade --cask fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-audit-u05-3-'))
    const home = join(root, 'home')
    const sys = join(root, 'sys')
    const caskDir = join(root, 'Caskroom', 'claude-code', '2.1.291')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    mkdirSync(sys)
    mkdirSync(caskDir, { recursive: true })
    // The real binary lives in a Caskroom folder; PATH sees it through a symlink, as Homebrew does.
    writeFileSync(join(caskDir, 'claude'), cli)
    chmodSync(join(caskDir, 'claude'), 0o755)
    symlinkSync(join(caskDir, 'claude'), join(sys, 'claude'))
    // A stand-in brew that fails (a network error) and records nothing else.
    writeFileSync(join(sys, 'brew'), '#!/bin/sh\necho "Error: network unreachable" >&2\nexit 1\n')
    chmodSync(join(sys, 'brew'), 0o755)

    const pathEnv = (): string => `${sys}:${home}/.local/bin`
    const capabilities = createCapabilityService({ pathEnv, home, timeoutMs: 8000 })
    const lifecycle = createLifecycle({ stateRoot: join(root, 'state'), home, capabilities, pathEnv })

    const plan = await lifecycle.plan('claude', 'update')
    expect(plan).toMatchObject({ available: true, executable: join(sys, 'brew'), args: ['upgrade', '--cask', 'claude-code'] })

    const { id } = await lifecycle.start('claude', 'update')
    await expect.poll(() => lifecycle.get(id)?.endedAt !== undefined, { timeout: 25_000, interval: 50 }).toBe(true)
    const op = lifecycle.get(id)!

    expect(op.state).toBe('error')
    expect(op.message).toMatch(/The update exited with 1/)
    // The plan that failed was brew's, so the manual route must be brew's too.
    expect(op.manual).toBe('brew upgrade --cask claude-code')
  }, 30_000)
})
