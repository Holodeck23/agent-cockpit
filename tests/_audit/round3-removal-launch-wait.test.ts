import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccountService, AccountInUseError } from '../../server/agents/accounts/service.ts'
import { resolved } from '../../server/agents/accounts/env.ts'
import { createAccountStore } from '../../server/agents/accounts/store.ts'
import { defaultAccountId } from '../../server/agents/accounts/types.ts'
import type { AgentSession, EventSink } from '../../server/agents/types.ts'
import { createThreadManager, ThreadBusyError, type LaunchRequest, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// Round 3, problem 2: while an account's removal waits for the CLI to sign it out (up to 30 s), the
// projects that chose it already select the default. A message sent to an idle conversation of such a
// project launched it on the default and rebound it (a new native session, an account note). If the
// sign-out was then refused, the selection went back to the profile but the conversation stayed bound
// to, and running on, the default. Chosen behaviour: a conversation of a project whose account is
// being removed is not launched until the removal settles; it is told why, and nothing changes.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const TIMEOUT = 30_000

interface Launch { readonly request: LaunchRequest; readonly emit: EventSink; alive: boolean }

/** The fixture claude, except that a sign-out takes `delay` seconds first and then fails (or succeeds). */
function slowSignOut(root: string, delay: number, outcome: 'fails' | 'works'): string {
  const wrapper = join(root, 'claude-slow-signout')
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then
  sleep ${delay}
  ${outcome === 'fails' ? 'echo "Logout failed: keychain locked" >&2; exit 1' : `exec "${join(FIXTURE, 'claude')}" "$@"`}
fi
exec "${join(FIXTURE, 'claude')}" "$@"
`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

function setup(outcome: 'fails' | 'works') {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-round3-removal-'))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
  writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
  const slow = slowSignOut(root, 1.2, outcome)
  const accountStore = createAccountStore(join(root, 'state'))
  const launches: Launch[] = []
  const launcher: Launcher = (request, onEvent) => {
    const launch: Launch = { request, emit: onEvent, alive: true }
    launches.push(launch)
    const session: AgentSession = {
      agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
      queues: () => true, cancelQueued: () => Promise.resolve(true),
      close: () => { if (launch.alive) { launch.alive = false; onEvent({ kind: 'exit', code: 0 }) } return Promise.resolve() },
      alive: () => launch.alive,
    }
    return session
  }
  const threads = createThreadStore(join(root, 'threads'))
  let service: ReturnType<typeof createAccountService>
  const manager = createThreadManager(threads, {
    launchers: { claude: launcher, codex: launcher },
    // The manager asks the real service, as start.ts wires it.
    accounts: { resolve: (projectPath, agent) => service.resolve(projectPath, agent), describe: (id) => service.describe(id) },
  })
  service = createAccountService({
    stateRoot: join(root, 'state'),
    store: accountStore,
    executable: async (agent) => (agent === 'claude' ? slow : join(FIXTURE, agent)),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    sessions: {
      activity: (projectPath, agent) => manager.accountActivity(projectPath, agent),
      inUse: (accountId) => manager.accountSessions(accountId),
      closeIdle: (accountId) => manager.closeAccountSessions(accountId),
      rebindProject: (projectPath, agent, to) => manager.rebindProject(projectPath, agent, to),
      identityChanged: (accountId, to, from) => manager.identityChanged(accountId, to, from),
    },
    timeoutMs: { signin: 15_000, logout: 10_000 },
  })
  return { service, manager, threads, launches, accountStore, state: join(root, 'state') }
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

/** A conversation on the profile with one finished turn, so its native session can be resumed. */
async function startedOn(h: ReturnType<typeof setup>, accountId: string) {
  await h.service.select('/proj', 'claude', accountId)
  const meta = h.manager.create({ projectPath: '/proj', settings: threadSettingsSchema.parse({}), text: 'work' })
  const launch = h.launches.at(-1)!
  launch.emit({ kind: 'session', sessionId: 'native-1' })
  launch.emit({ kind: 'assistant_text', messageId: 'm', text: 'done' })
  launch.emit({ kind: 'result', ok: true })
  expect(h.threads.get(meta.id)).toMatchObject({ sessionId: 'native-1', sessionStarted: true, accountId })
  return meta
}

const accountNotes = (h: ReturnType<typeof setup>, threadId: string) => h.threads.events(threadId).filter((e) => e.event.kind === 'account_changed').map((e) => e.event)

describe('round 3: a conversation of a project whose account is being removed waits for the removal to settle', () => {
  it('a message sent during the sign-out is refused, and a refused removal then leaves the conversation on the profile', async () => {
    const h = setup('fails')
    const work = await addClaude(h.service, 'Work', 'b@example.com')
    const meta = await startedOn(h, work.id)
    const launched = h.launches.length
    const logged = h.threads.events(meta.id).length

    const removal = h.service.remove(work.id, { moveProjectsToDefault: true }).catch((e: unknown) => e)
    // The sign-out is running: the project already selects the default.
    await until(() => h.service.forProject('/proj').claude, (id) => id === defaultAccountId('claude'))

    let refusal: unknown
    try { h.manager.send(meta.id, 'again') } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(ThreadBusyError)
    expect((refusal as Error).message).toMatch(/“Work” is being removed/)
    // Nothing launched, nothing recorded: the message was not accepted.
    expect(h.launches).toHaveLength(launched)
    expect(h.threads.events(meta.id)).toHaveLength(logged)

    expect(await removal).toBeInstanceOf(AccountInUseError)

    // Refused removal: nothing a conversation can see has changed.
    expect(h.service.forProject('/proj').claude).toBe(work.id)
    expect(h.threads.get(meta.id)).toMatchObject({ sessionId: 'native-1', sessionStarted: true, accountId: work.id })
    expect(accountNotes(h, meta.id)).toEqual([])
    // And once it has settled the conversation carries on, resuming on the profile.
    h.manager.send(meta.id, 'again')
    expect(h.launches.at(-1)!.request).toMatchObject({ resume: 'native-1', accountEnv: { CLAUDE_CONFIG_DIR: join(h.state, 'account-profiles', work.id) } })
  }, TIMEOUT)

  it('when the removal goes through the same refusal ends with it: the conversation then moves to the default once', async () => {
    const h = setup('works')
    const work = await addClaude(h.service, 'Work', 'b@example.com')
    const meta = await startedOn(h, work.id)

    const removal = h.service.remove(work.id, { moveProjectsToDefault: true })
    await until(() => h.service.forProject('/proj').claude, (id) => id === defaultAccountId('claude'))
    expect(() => h.manager.send(meta.id, 'again')).toThrow(ThreadBusyError)
    await removal

    expect(accountNotes(h, meta.id)).toEqual([expect.objectContaining({ from: expect.objectContaining({ label: 'Work' }), reason: 'selected' })])
    h.manager.send(meta.id, 'again')
    expect(h.launches.at(-1)!.request).not.toHaveProperty('accountEnv')
    expect(h.threads.get(meta.id)).toMatchObject({ accountId: defaultAccountId('claude') })
  }, TIMEOUT)
})
