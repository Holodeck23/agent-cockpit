import { describe, expect, it } from 'vitest'
import type { ApprovalBehavior } from '../server/agents/types.ts'
import { createBrowserAgent, type ActOutcome, type AgentInput, type AgentPageInfo, type BrowserHost } from '../server/browser/agent.ts'
import { createBrowserLeases } from '../server/browser/agent-policy.ts'
import { HttpError } from '../server/http/json.ts'

// The browser agent's decisions (W9-06–W9-09, SEC-03): scope derived from the session grant,
// approvals for remote sites and every input, run+origin grants and what revokes them.

const grant = { threadId: 't1', projectPath: '/work/one', cwd: '/work/one' }
const signal = new AbortController().signal

function harness(start = 'http://localhost:5173/') {
  let url = start
  let revision = 7
  const page = (): AgentPageInfo => ({ pageId: 'thread:t1', revision, url, origin: new URL(url).origin, title: 'T', loading: false, viewport: { width: 800, height: 600 }, timestamp: 'now' })
  const acts: Array<{ input: AgentInput; expect: { revision: number; origin: string } }> = []
  const asked: Array<{ tool: string; input: Record<string, unknown>; label?: string }> = []
  const answers: Array<ApprovalBehavior | Error> = []
  let run: string | undefined = 'r1'
  let changed: string | undefined
  const host: BrowserHost = {
    info: (key) => (key === 'thread:t1' ? page() : undefined),
    ensure: async () => page(),
    goto: async (_key, next) => { url = next; revision++; return page() },
    historyUrl: () => 'https://back.test/',
    history: async () => page(),
    read: async () => { if (changed) throw new Error(changed); return { page: page(), text: 'hello', elements: [], scroll: { x: 0, y: 0 }, truncated: false } },
    capture: async () => { if (changed) throw new Error(changed); return { data: 'png', mimeType: 'image/png', width: 800, height: 600, page: page() } },
    act: async (_key, input, expect): Promise<ActOutcome> => { acts.push({ input, expect }); return { outcome: 'done', detail: 'ok', page: page() } },
  }
  const leases = createBrowserLeases()
  const agent = createBrowserAgent({
    host: () => host,
    leases,
    cockpitPorts: () => [4000],
    currentRun: () => run,
    approve: async (_grant, tool, input, options) => {
      asked.push({ tool, input, ...(options.grant ? { label: options.grant.label } : {}) })
      const answer = answers.shift() ?? 'allow'
      if (answer instanceof Error) throw answer
      if (answer === 'deny') throw new Error('Browser action denied by the user')
      return answer
    },
  })
  return {
    agent, leases, acts, asked, answers,
    call: (op: string, body: unknown = {}) => agent.handle(grant, op, body, signal),
    setRun: (next: string | undefined) => { run = next },
    setUrl: (next: string) => { url = next; revision++ },
    pageChanges: (message: string | undefined) => { changed = message },
    revision: () => revision,
  }
}

const status = async (promise: Promise<unknown>): Promise<number | 'ok'> => promise.then(() => 'ok' as const, (error: unknown) => (error instanceof HttpError ? error.status : -1))

describe('browser scope comes from the session, not the request (W9-08, SEC-03)', () => {
  it('refuses another conversation’s page id without saying whether it exists', async () => {
    const h = harness()
    await expect(h.call('read', { pageId: 'thread:t2' })).rejects.toMatchObject({ status: 403, message: expect.not.stringContaining('t2') })
    await expect(h.call('read', { pageId: 'thread:does-not-exist' })).rejects.toMatchObject({ status: 403 })
    expect(await status(h.call('read', { pageId: 'thread:t1' }))).toBe('ok')
  })

  it('refuses a forged run, thread or workspace field', async () => {
    const h = harness()
    expect(await status(h.call('click', { revision: 7, x: 1, y: 1, runId: 'r-other' }))).toBe(400)
    expect(await status(h.call('navigate', { url: 'http://localhost:5173/', threadId: 't2' }))).toBe(400)
    expect(await status(h.call('read', { workspaceId: 'w2' }))).toBe(400)
    expect(h.acts).toEqual([])
  })

  it('knows only its own operations, not names an object inherits', async () => {
    const h = harness()
    for (const op of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '..%2Fthreads']) expect(await status(h.call(op))).toBe(404)
  })

  it('works only while the conversation is working, and not after Stop', async () => {
    const h = harness()
    h.setRun(undefined)
    expect(await status(h.call('read'))).toBe(409)
    expect(await status(h.call('click', { revision: 7, x: 1, y: 1 }))).toBe(409)
    expect(h.asked).toEqual([])
  })
})

describe('a page that changes while it is read (W9-07)', () => {
  it('answers 409 with the host’s words and returns nothing', async () => {
    const h = harness()
    h.pageChanges('The page changed while it was being read')
    for (const op of ['read', 'screenshot']) {
      await expect(h.call(op)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed while it was being read') })
    }
  })
})

describe('browser policy (W9-06, W9-09)', () => {
  it('reads and screenshots a local app without asking', async () => {
    const h = harness()
    await h.call('read')
    await h.call('screenshot')
    await h.call('navigate', { url: 'http://127.0.0.1:3000/' })
    expect(h.asked).toEqual([])
  })

  it('asks before opening or reading a remote site, and before any input, even on a local app', async () => {
    const h = harness()
    await h.call('navigate', { url: 'https://shop.test/cart' })
    expect(h.asked.at(-1)).toMatchObject({ tool: 'mcp__cockpit__browser_navigate', input: { origin: 'https://shop.test', url: 'https://shop.test/cart' }, label: 'Allow on shop.test for this run' })
    await h.call('read')
    expect(h.asked).toHaveLength(2)
    const local = harness()
    await local.call('click', { revision: 7, x: 10, y: 10 })
    expect(local.asked.at(-1)).toMatchObject({ tool: 'mcp__cockpit__browser_click', input: { origin: 'http://localhost:5173', action: 'click', x: 10, y: 10 } })
  })

  it('refuses Cockpit itself and non-web schemes before asking anyone', async () => {
    const h = harness()
    for (const url of ['http://127.0.0.1:4000/api/threads', 'file:///etc/hosts', 'javascript:alert(1)', 'chrome://gpu']) {
      expect(await status(h.call('navigate', { url }))).toBe(400)
    }
    expect(h.asked).toEqual([])
  })

  it('Allow lets one action through; the run grant covers that exact origin for the rest of the run', async () => {
    const h = harness('https://shop.test/')
    h.answers.push('allow')
    await h.call('click', { revision: 7, x: 5, y: 5 })
    await h.call('click', { revision: 7, x: 5, y: 5 })
    expect(h.asked).toHaveLength(2)
    h.answers.push('allow_session')
    await h.call('click', { revision: 7, x: 5, y: 5 })
    await h.call('type', { revision: 7, text: 'abc' })
    await h.call('read')
    expect(h.asked).toHaveLength(3)
    // Another origin needs its own grant.
    h.setUrl('https://other.test/')
    await h.call('click', { revision: h.revision(), x: 5, y: 5 })
    expect(h.asked).toHaveLength(4)
    expect(h.asked.at(-1)!.input.origin).toBe('https://other.test')
  })

  it('a new run starts with no grants', async () => {
    const h = harness('https://shop.test/')
    h.answers.push('allow_session')
    await h.call('click', { revision: 7, x: 5, y: 5 })
    h.setRun('r2')
    await h.call('click', { revision: 7, x: 5, y: 5 })
    expect(h.asked).toHaveLength(2)
    expect(h.leases.list().every((l) => l.runId === 'r2')).toBe(true)
  })

  it('Deny or an expired approval does nothing and removes the conversation’s grants', async () => {
    const h = harness('https://shop.test/')
    h.answers.push('allow_session')
    await h.call('click', { revision: 7, x: 5, y: 5 })
    h.setUrl('https://other.test/')
    h.answers.push('deny')
    expect(await status(h.call('click', { revision: h.revision(), x: 5, y: 5 }))).toBe(409)
    expect(h.leases.list()).toEqual([])
    h.answers.push(new Error('Browser action approval expired; request it again'))
    expect(await status(h.call('navigate', { url: 'https://third.test/' }))).toBe(409)
    expect(h.acts).toHaveLength(1)
  })

  it('does nothing when the run ended (Stop) while the person was deciding (CROSS-05)', async () => {
    let release!: () => void
    const decided = new Promise<void>((r) => { release = r })
    const leases = createBrowserLeases()
    let run: string | undefined = 'r1'
    const acts: unknown[] = []
    const agent = createBrowserAgent({
      host: () => ({ ...hostFor('https://shop.test/'), act: async () => { acts.push(1); return { outcome: 'done', detail: '', page: pageAt('https://shop.test/') } } }),
      leases, cockpitPorts: () => [], currentRun: () => run,
      approve: async () => { await decided; return 'allow_session' },
    })
    const pending = agent.handle(grant, 'click', { revision: 7, x: 1, y: 1 }, signal)
    run = undefined
    release()
    expect(await status(pending)).toBe(409)
    expect(acts).toEqual([])
    expect(leases.list()).toEqual([])
  })

  it('passes the revision the agent observed and the origin it was approved for to the host', async () => {
    const h = harness('https://shop.test/')
    h.answers.push('allow')
    await h.call('type', { revision: 5, ref: 'e5-2', text: 'secret words' })
    expect(h.acts[0]).toEqual({ input: { kind: 'type', ref: 'e5-2', text: 'secret words' }, expect: { revision: 5, origin: 'https://shop.test' } })
    // The card shows where and how much, never what.
    expect(JSON.stringify(h.asked)).not.toContain('secret words')
    expect(h.asked[0]!.input).toMatchObject({ action: 'type', ref: 'e5-2', characters: 12 })
  })
})

function pageAt(url: string): AgentPageInfo {
  return { pageId: 'thread:t1', revision: 7, url, origin: new URL(url).origin, title: '', loading: false, viewport: { width: 800, height: 600 }, timestamp: '' }
}
function hostFor(url: string): BrowserHost {
  return {
    info: () => pageAt(url), ensure: async () => pageAt(url), goto: async () => pageAt(url), historyUrl: () => undefined, history: async () => pageAt(url),
    read: async () => ({ page: pageAt(url), text: '', elements: [], scroll: { x: 0, y: 0 }, truncated: false }),
    capture: async () => ({ data: '', mimeType: 'image/png', width: 1, height: 1, page: pageAt(url) }),
    act: async () => ({ outcome: 'done', detail: '', page: pageAt(url) }),
  }
}
