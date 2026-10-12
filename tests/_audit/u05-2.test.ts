import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../../server/agents/capabilities/service.ts'
import { createLifecycle, type OperationView } from '../../server/agents/lifecycle/service.ts'

// u05-2: Cancel must stop an install or update that has not spawned its helper yet. Today
// cancel() returns false while entry.run is unset (installer download / closeIdle / capability
// refresh), records nothing, and the helper starts afterwards anyway.
const HELP = '  --print\n  --permission-mode <mode>  (choices: "default", "plan")\n'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function cliScript(version: string, marker?: string): string {
  return `#!/bin/sh
case "$1" in
${marker ? `update) touch "${marker}" ;;` : ''}
--version) echo "${version}" ;;
--help) printf '${HELP.replace(/\n/g, '\\n')}' ;;
auth) echo '{"loggedIn": false}'; exit 1 ;;
*) exit 0 ;;
esac
`
}

function base() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-u05-2-'))
  const home = join(root, 'home')
  const sys = join(root, 'sys')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(sys)
  const pathEnv = (): string => `${sys}:${home}/.local/bin`
  const capabilities = createCapabilityService({ pathEnv, home, timeoutMs: 8000 })
  return { root, home, pathEnv, capabilities }
}

const finished = async (lifecycle: ReturnType<typeof createLifecycle>, id: string): Promise<OperationView> => {
  await expect.poll(() => lifecycle.get(id)?.endedAt !== undefined, { timeout: 25_000, interval: 50 }).toBe(true)
  return lifecycle.get(id)!
}

describe('u05-2: cancel before the helper process exists', () => {
  it('cancelling an install during the installer download means the installer never runs', { timeout: 40_000 }, async () => {
    const { root, home, pathEnv, capabilities } = base()
    const marker = join(root, 'installer-ran')
    const script = `#!/bin/bash\ntouch "${marker}"\nmkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/claude" <<'EOF'\n${cliScript('2.1.291 (Claude Code)')}EOF\nchmod +x "$HOME/.local/bin/claude"\n`
    const bytes = Buffer.from(script)
    const gate = deferred<Buffer>()
    const lifecycle = createLifecycle({
      stateRoot: join(root, 'state'), home, capabilities, pathEnv,
      download: () => gate.promise,
      installers: { claude: { url: 'https://claude.ai/install.sh', hosts: ['claude.ai'], sha256: createHash('sha256').update(bytes).digest('hex'), args: [] } },
    })

    const { id } = await lifecycle.start('claude', 'install')
    expect(lifecycle.get(id)?.state).toBe('installing')

    // The user clicks Cancel while the script is still downloading.
    const accepted = lifecycle.cancel(id)

    gate.resolve(bytes)
    const op = await finished(lifecycle, id)

    expect(existsSync(marker)).toBe(false)
    expect(accepted).toBe(true)
    expect(op.state).toBe('cancelled')
  })

  it('cancelling an update while idle sessions are being closed means the updater never runs', { timeout: 40_000 }, async () => {
    const { root, home, pathEnv, capabilities } = base()
    const marker = join(root, 'updater-ran')
    writeFileSync(join(home, '.local', 'bin', 'agy'), cliScript('1.2.16', marker))
    chmodSync(join(home, '.local', 'bin', 'agy'), 0o755)
    const gate = deferred()
    const lifecycle = createLifecycle({
      stateRoot: join(root, 'state'), home, capabilities, pathEnv,
      sessions: { activity: () => ({ busy: 0 }), closeIdle: () => gate.promise },
    })

    const { id } = await lifecycle.start('antigravity', 'update')
    expect(lifecycle.get(id)?.state).toBe('updating')

    // The user clicks Cancel while idle sessions are still closing (no helper spawned yet).
    const accepted = lifecycle.cancel(id)

    gate.resolve()
    const op = await finished(lifecycle, id)

    expect(existsSync(marker)).toBe(false)
    expect(accepted).toBe(true)
    expect(op.state).toBe('cancelled')
  })
})
