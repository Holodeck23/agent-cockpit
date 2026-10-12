import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccountService, AccountInUseError } from '../../server/agents/accounts/service.ts'
import { resolved } from '../../server/agents/accounts/env.ts'
import { createAccountStore } from '../../server/agents/accounts/store.ts'
import { defaultAccountId } from '../../server/agents/accounts/types.ts'
import type { AgentSession, EventSink } from '../../server/agents/types.ts'
import { createThreadManager, type LaunchRequest, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// Review of u02: a refused account removal put each project's selection back with service.select(),
// which also rebinds the project's conversations. Moving to the default and back ran that
// non-invertible rebind twice: each conversation got a new native session id (resume lost) and two
// account-change notes, for a removal that changed nothing. A refused removal must change nothing a
// conversation can see.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const TIMEOUT = 30_000

interface Launch { readonly request: LaunchRequest; readonly emit: EventSink; alive: boolean }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-review-removal-'))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
  writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
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
  const manager = createThreadManager(threads, {
    launchers: { claude: launcher, codex: launcher },
    accounts: {
      resolve(projectPath, agent) {
        const account = accountStore.selected(projectPath, agent)
        return resolved(account, account.mode === 'managed' ? accountStore.profileDir(account.id) : undefined)
      },
      describe(id) {
        const account = accountStore.get(id)
        return account ? { id, label: account.label } : undefined
      },
    },
  })
  const service = createAccountService({
    stateRoot: join(root, 'state'),
    store: accountStore,
    executable: async (agent) => join(FIXTURE, agent),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    sessions: {
      activity: (projectPath, agent) => manager.accountActivity(projectPath, agent),
      inUse: (accountId) => manager.accountSessions(accountId),
      closeIdle: (accountId) => manager.closeAccountSessions(accountId),
      rebindProject: (projectPath, agent, to) => manager.rebindProject(projectPath, agent, to),
      identityChanged: (accountId, to, from) => manager.identityChanged(accountId, to, from),
    },
    timeoutMs: { signin: 15_000, logout: 5_000 },
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

describe('review: a refused account removal leaves the conversations as they were', () => {
  it('sign-out fails: no new native session, no account-change note, and the next message resumes on the profile', async () => {
    const h = setup()
    const work = await addClaude(h.service, 'Work', 'b@example.com')
    const meta = await startedOn(h, work.id)
    writeFileSync(join(h.state, 'account-profiles', work.id, '.fixture-logout-fails'), '')

    const outcome = await h.service.remove(work.id, { moveProjectsToDefault: true }).catch((e: unknown) => e)
    expect(outcome).toBeInstanceOf(AccountInUseError)

    expect(h.service.forProject('/proj').claude).toBe(work.id)
    expect(h.threads.get(meta.id)).toMatchObject({ sessionId: 'native-1', sessionStarted: true, accountId: work.id })
    expect(accountNotes(h, meta.id)).toEqual([])
    h.manager.send(meta.id, 'again')
    expect(h.launches.at(-1)!.request).toMatchObject({ resume: 'native-1', accountEnv: { CLAUDE_CONFIG_DIR: join(h.state, 'account-profiles', work.id) } })
  }, TIMEOUT)

  it('a busy project refuses the removal before any other project moves, so none is rebound and put back', async () => {
    const h = setup()
    const work = await addClaude(h.service, 'Work', 'b@example.com')
    const meta = await startedOn(h, work.id)
    // /busy has a conversation working on the default; the project itself chooses the profile.
    h.manager.create({ projectPath: '/busy', settings: threadSettingsSchema.parse({}), text: 'still working' })
    h.accountStore.select('/busy', 'claude', work.id)

    await expect(h.service.remove(work.id, { moveProjectsToDefault: true })).rejects.toThrow(/still working/)

    expect(h.service.forProject('/proj').claude).toBe(work.id)
    expect(h.service.forProject('/busy').claude).toBe(work.id)
    expect(h.threads.get(meta.id)).toMatchObject({ sessionId: 'native-1', sessionStarted: true, accountId: work.id })
    expect(accountNotes(h, meta.id)).toEqual([])
  }, TIMEOUT)

  it('control: a removal that goes through moves the conversation once, naming the profile it left', async () => {
    const h = setup()
    const work = await addClaude(h.service, 'Work', 'b@example.com')
    const meta = await startedOn(h, work.id)

    await h.service.remove(work.id, { moveProjectsToDefault: true })

    expect(h.service.forProject('/proj').claude).toBe(defaultAccountId('claude'))
    expect(h.threads.get(meta.id)).toMatchObject({ sessionStarted: false, accountId: defaultAccountId('claude') })
    expect(accountNotes(h, meta.id)).toEqual([expect.objectContaining({ from: expect.objectContaining({ label: 'Work' }), reason: 'selected' })])
  }, TIMEOUT)
})
