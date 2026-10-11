import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccountService, type AccountSessions } from '../../server/agents/accounts/service.ts'

// u02-4: shutdown() must not resolve until a cancelled sign-in's discard (CLI logout + folder
// delete) has finished. start.ts close() awaits accountService.shutdown(), and the CLI entry and
// Electron's before-quit handler exit the process as soon as close() resolves. If shutdown() only
// waits for the helper to die, the unfinished <root>/account-profiles/<uuid> folder is still on
// disk when the process exits, and nothing ever sweeps it. Uses the stand-in CLI fixture only.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-audit-u02-4-'))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
  writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
  const sessions: AccountSessions = {
    activity: () => ({ busy: 0, queued: 0 }),
    inUse: () => 0,
    closeIdle: async () => undefined,
    rebindProject: async () => undefined,
    identityChanged: async () => undefined,
  }
  const service = createAccountService({
    stateRoot: join(root, 'state'),
    executable: async (agent) => join(FIXTURE, agent),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    sessions,
    timeoutMs: { signin: 15_000, logout: 5_000 },
  })
  return { service, state: join(root, 'state') }
}

async function until<T>(read: () => T | undefined, test: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined && test(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const profiles = (state: string): string[] => (existsSync(join(state, 'account-profiles')) ? readdirSync(join(state, 'account-profiles')) : [])

describe('u02-4: quitting with a sign-in open', () => {
  for (const agent of ['claude', 'codex'] as const) {
    it(`${agent}: shutdown() resolves only after the cancelled sign-in's unfinished profile is discarded`, async () => {
      const { service, state } = setup()
      const started = await service.startSignin(agent, 'Quit mid sign-in')
      await until(() => service.signin(started.id), (v) => v.url !== undefined)
      expect(profiles(state)).toHaveLength(1)

      await service.shutdown()
      // What the process sees the instant close() resolves and it exits.
      const leftAtExit = profiles(state)

      // Tidy the temp dir regardless of the outcome: let the late discard finish.
      await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))

      expect(leftAtExit).toEqual([])
    }, 30_000)
  }
})
