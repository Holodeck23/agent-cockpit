import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountInUseError, createAccountService, type AccountSessions } from '../../server/agents/accounts/service.ts'
import { defaultAccountId, type ResolvedAccount } from '../../server/agents/accounts/types.ts'
import type { AgentId } from '../../server/agents/types.ts'

// u02-3: remove(id, { moveProjectsToDefault: true }) switches every choosing project to the CLI
// default BEFORE the sign-out. When the removal then fails ("Cockpit kept it"), the profile still
// exists but the projects stay on the default. A failed removal must leave selections as they were.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const TIMEOUT = 30_000

function setup(over: Partial<AccountSessions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-audit-u02-3-'))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
  writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
  const rebinds: Array<{ project: string; to: string }> = []
  const sessions: AccountSessions = {
    activity: () => ({ busy: 0, queued: 0 }),
    inUse: () => 0,
    closeIdle: async () => {},
    rebindProject: async (project: string, _agent: AgentId, to: ResolvedAccount) => { rebinds.push({ project, to: to.accountId }) },
    identityChanged: async () => {},
    ...over,
  }
  const service = createAccountService({
    stateRoot: join(root, 'state'),
    executable: async (agent) => join(FIXTURE, agent),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    sessions,
    timeoutMs: { signin: 15_000, logout: 5_000 },
  })
  return { service, rebinds, state: join(root, 'state') }
}

async function until<T>(read: () => T | undefined, test: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined && test(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function addClaude(service: ReturnType<typeof setup>['service'], label: string, email: string) {
  const started = await service.startSignin('claude', label)
  await until(() => service.signin(started.id), (v) => v.url !== undefined)
  service.signinInput(started.id, `ok:${email}`)
  const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))
  if (!done.account) throw new Error(done.message)
  return done.account
}

describe('u02-3: a failed removal must not leave projects moved to the CLI default', () => {
  it('sign-out fails: the profile is kept, so the projects still choose it', async () => {
    const { service, state } = setup()
    const work = await addClaude(service, 'Work', 'b@example.com')
    await service.select('/proj-a', 'claude', work.id)
    await service.select('/proj-b', 'claude', work.id)
    writeFileSync(join(state, 'account-profiles', work.id, '.fixture-logout-fails'), '')

    const outcome = await service.remove(work.id, { moveProjectsToDefault: true }).catch((e: unknown) => e)
    expect(outcome).toBeInstanceOf(AccountInUseError)
    expect((outcome as Error).message).toMatch(/kept it/)

    // The profile survived ...
    expect(service.list().some((a) => a.id === work.id)).toBe(true)
    // ... so a failed removal must not have changed which account the projects run on.
    expect(service.forProject('/proj-a').claude).toBe(work.id)
    expect(service.forProject('/proj-b').claude).toBe(work.id)
    expect(service.forProject('/proj-a').claude).not.toBe(defaultAccountId('claude'))
  }, TIMEOUT)

  it('a turn starts while idle sessions close: the refusal leaves the selection untouched', async () => {
    let inUse = 0
    const { service, rebinds } = setup({
      inUse: () => inUse,
      closeIdle: async () => { inUse = 1 },
    })
    const work = await addClaude(service, 'Work', 'b@example.com')
    await service.select('/proj-a', 'claude', work.id)
    rebinds.length = 0

    await expect(service.remove(work.id, { moveProjectsToDefault: true })).rejects.toThrow(/started on .* just now/)

    expect(service.forProject('/proj-a').claude).toBe(work.id)
    // And no conversation was rebound onto the default account for a removal that did not happen.
    expect(rebinds).toEqual([])
  }, TIMEOUT)
})
