import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccountService, type AccountSessions } from '../../server/agents/accounts/service.ts'
import type { IdentityObservation } from '../../server/agents/accounts/types.ts'

// u02-2: Cancel pressed while the sign-in is in its 'checking' phase (helper already exited 0, the
// identity probe is still running). The correct behaviour: a Cancel that is reported as accepted
// (cancelSignin -> true) must mean no account is added; or Cancel is refused (false) so the API
// does not claim something it does not do. Today it returns true and the profile is still created.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')

async function until<T>(read: () => T | undefined, test: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined && test(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('u02-2: cancelling a sign-in during the identity check', () => {
  it('a cancel that is accepted must not still add the account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-u02-2-'))
    const home = join(root, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
    const state = join(root, 'state')

    let releaseProbe!: (o: IdentityObservation) => void
    let probeStarted = false
    const probeGate = new Promise<IdentityObservation>((r) => { releaseProbe = r })

    const sessions: AccountSessions = {
      activity: () => ({ busy: 0, queued: 0 }),
      inUse: () => 0,
      closeIdle: async () => undefined,
      rebindProject: async () => undefined,
      identityChanged: async () => undefined,
    }
    const service = createAccountService({
      stateRoot: state,
      executable: async (agent) => join(FIXTURE, agent),
      env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
      probe: async () => { probeStarted = true; return probeGate },
      sessions,
      timeoutMs: { signin: 15_000, logout: 5_000 },
    })

    const started = await service.startSignin('codex', 'Second')
    await until(() => service.signin(started.id), (v) => v.url !== undefined)
    const [dir] = readdirSync(join(state, 'account-profiles'))
    // The browser finishes the sign-in: the helper exits 0 and the service moves on to 'checking'.
    writeFileSync(join(state, 'account-profiles', dir!, '.fixture-callback'), 'ok:c@example.com\n')
    await until(() => service.signin(started.id), (v) => v.state === 'checking')
    await until(() => probeStarted, (v) => v === true)

    // The user presses Cancel while "Checking which account signed in…" is shown.
    const accepted = service.cancelSignin(started.id)

    // The identity probe now answers.
    releaseProbe({ state: 'known', key: 'key-c', hint: 'c…@example.com · plus', observedAt: new Date().toISOString(), source: 'codex account/read' })
    const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))

    const managed = service.list().filter((a) => a.mode === 'managed')
    if (accepted) {
      // Cancel was reported as accepted: it must have taken effect.
      expect(done.state).toBe('cancelled')
      expect(managed).toEqual([])
      expect(existsSync(join(state, 'account-profiles', dir!))).toBe(false)
    } else {
      // Honest refusal is also acceptable; the sign-in then completes as before.
      expect(done.state).toBe('verified')
    }
  }, 30_000)
})
