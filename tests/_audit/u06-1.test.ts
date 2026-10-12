import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApprovalBehavior } from '../../server/agents/types.ts'
import { createBrowserAgent, type AgentPageInfo, type BrowserHost } from '../../server/browser/agent.ts'
import { createBrowserLeases, originClass, originOf } from '../../server/browser/agent-policy.ts'
import { isNavigable } from '../../electron/browser-policy.ts'

// u06-1: browser_navigate asks for approval only when the TARGET url is remote
// (server/browser/agent.ts:187-189). A local target (any loopback port that is not Cockpit) loads with
// no approval, and the Electron host (electron/browser-service.ts:132-134) follows its redirects to any
// remote origin, because will-navigate / will-redirect only veto what isNavigable() refuses (non-http(s)
// and Cockpit). So a local server that answers 302 -> https://shop.test/delete?id=1 puts the remote
// request into the workspace's signed-in partition with no card shown.
//
// CORRECT behaviour: a local page may not take the agent's browser to a remote origin that the person has
// not been asked about. The person is asked about that origin, and a Deny means navigate does not succeed.

const REMOTE = 'https://shop.test'
const REMOTE_TARGET = `${REMOTE}/delete?id=1`
const grant = { threadId: 't1', projectPath: '/work/one', cwd: '/work/one' }

let local: Server
let localUrl = ''

beforeAll(async () => {
  local = createServer((_req, res) => { res.writeHead(302, { location: REMOTE_TARGET }); res.end() })
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve))
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/`
})
afterAll(async () => { await new Promise((resolve) => local.close(resolve)) })

/**
 * A stand-in for electron/browser-agent-host.ts + browser-service.ts: goto() really fetches the local
 * server, and follows each redirect exactly as the host's will-redirect handler does, i.e. it lets a hop
 * through whenever the real isNavigable() (electron/browser-policy.ts) says yes. Like the service's
 * onBeforeRequest, it holds every main-frame request for the guard the agent installed (guardNavigation)
 * before the request goes out, and a refusal rejects the call. It records every URL the page actually
 * requested, so we can see what went out.
 */
function harness(cockpitPorts: number[], remoteRedirects: (url: string) => string | undefined = () => undefined, hangUp = new AbortController()) {
  let run: string | undefined = 'r1'
  let over: (() => boolean) | undefined
  let url = 'about:blank'
  let revision = 1
  const requested: string[] = []
  const asked: Array<{ tool: string; input: Record<string, unknown> }> = []
  let answer: ApprovalBehavior | 'deny' = 'deny'
  const refusedOrigins = new Set<string>()
  const page = (): AgentPageInfo => ({ pageId: 'thread:t1', revision, url, origin: originOf(url) ?? 'null', title: '', loading: false, viewport: { width: 800, height: 600 }, timestamp: 'now' })
  let authorize: (url: string) => Promise<void> = async () => {}
  const host: BrowserHost = {
    guardNavigation: (_key, guard, options) => { authorize = guard; over = options?.over },
    info: () => page(),
    ensure: async () => page(),
    goto: async (_key, target) => {
      let next = target
      for (let hop = 0; hop < 30; hop++) {
        await authorize(next)
        requested.push(next)
        url = next
        let location: string | null | undefined
        if (originOf(next) === originOf(localUrl)) {
          const res = await fetch(next, { redirect: 'manual' })
          location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : undefined
        } else {
          location = remoteRedirects(next) // a "remote site": nothing to fetch, it has been requested
        }
        if (!location) break
        const hopUrl = new URL(location, next).toString()
        if (!isNavigable(hopUrl, cockpitPorts)) break // will-redirect -> preventDefault
        next = hopUrl
      }
      revision++
      return page()
    },
    historyUrl: () => undefined,
    history: async () => page(),
    read: async () => ({ page: page(), text: '', elements: [], scroll: { x: 0, y: 0 }, truncated: false }),
    capture: async () => ({ data: '', mimeType: 'image/png', width: 800, height: 600, page: page() }),
    act: async () => ({ outcome: 'done', detail: 'ok', page: page() }),
  }
  const agent = createBrowserAgent({
    host: () => host,
    leases: createBrowserLeases(),
    cockpitPorts: () => cockpitPorts,
    currentRun: () => run,
    approve: async (_grant, tool, input) => {
      asked.push({ tool, input })
      if (answer === 'deny' || refusedOrigins.has(input.origin as string)) throw new Error('Browser action denied by the user')
      return answer
    },
  })
  return { call: (op: string, body: unknown = {}) => agent.handle(grant, op, body, hangUp.signal), requested, asked, endRun: () => { run = undefined }, guardOver: () => over?.(), authorize: (target: string) => authorize(target), setAnswer: (a: ApprovalBehavior | 'deny') => { answer = a }, refuse: (origin: string) => { refusedOrigins.add(origin) }, current: () => url }
}

describe('u06-1: a local page cannot carry the browser to a remote site unasked', () => {
  it('control: navigating straight to the remote URL asks first, and a Deny stops the request', async () => {
    const h = harness([4000])
    await expect(h.call('navigate', { url: REMOTE_TARGET })).rejects.toMatchObject({ status: 409 })
    expect(h.asked.map((a) => a.input.origin)).toEqual([REMOTE])
    expect(h.requested).toEqual([])
  })

  it('a local URL that 302s to the remote site is asked about too, and a Deny means navigate does not succeed', async () => {
    const h = harness([4000])
    const result = await h.call('navigate', { url: localUrl }).then(
      (page) => ({ ok: true as const, page: page as AgentPageInfo }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // The person must have been asked about the remote origin the page ended on ...
    expect(h.asked.map((a) => a.input.origin)).toContain(REMOTE)
    // ... and having said no, the agent must not be handed the remote page as a successful navigation.
    expect(result.ok).toBe(false)
    expect(h.requested).not.toContain(REMOTE_TARGET)
  })
})

// The guard holds the redirect before its request goes out, and asks with the address the call was heading for.
describe('u06-1: the host stops a redirect to a remote site until the person has said yes', () => {
  it('a Deny means the remote site is never requested and the page stays where it was', async () => {
    const h = harness([4000])
    await expect(h.call('navigate', { url: localUrl })).rejects.toMatchObject({ status: 409 })
    expect(h.asked.map((a) => a.input.origin)).toEqual([REMOTE])
    expect(h.asked[0]!.input).toMatchObject({ url: REMOTE_TARGET, redirectedFrom: localUrl })
    expect(h.requested).toEqual([localUrl])
  })

  it('an Allow follows the redirect once, and the agent is handed the page without the host\'s note', async () => {
    const h = harness([4000])
    h.setAnswer('allow')
    const page = await h.call('navigate', { url: localUrl }) as AgentPageInfo
    expect(h.requested).toEqual([localUrl, REMOTE_TARGET])
    expect(h.asked.map((a) => a.input.origin)).toEqual([REMOTE])
    expect(page.url).toBe(REMOTE_TARGET)
    expect(page).not.toHaveProperty('blocked')
  })

  it('asks about each remote site on a chain, and stops asking when one is denied', async () => {
    const redirects = (u: string): string | undefined => (u === 'https://a.test/' ? 'https://b.test/x' : undefined)
    const allowBoth = harness([4000], redirects)
    allowBoth.setAnswer('allow')
    expect((await allowBoth.call('navigate', { url: 'https://a.test/' }) as AgentPageInfo).url).toBe('https://b.test/x')
    expect(allowBoth.asked.map((a) => a.input.origin)).toEqual(['https://a.test', 'https://b.test'])

    const denySecond = harness([4000], redirects)
    denySecond.setAnswer('allow')
    denySecond.refuse('https://b.test')
    await expect(denySecond.call('navigate', { url: 'https://a.test/' })).rejects.toMatchObject({ status: 409 })
    expect(denySecond.asked.map((a) => a.input.origin)).toEqual(['https://a.test', 'https://b.test'])
    expect(denySecond.requested).toEqual(['https://a.test/'])
    expect(denySecond.current()).toBe('https://a.test/')
  })

  it('gives up on a page that keeps redirecting to new sites', async () => {
    const h = harness([4000], (u) => `https://r${Number(/r(\d+)\.test/.exec(u)?.[1] ?? 0) + 1}.test/`)
    h.setAnswer('allow')
    await expect(h.call('navigate', { url: 'https://r0.test/' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/kept redirecting/) })
    expect(h.asked.length).toBeLessThan(10)
  })
})

// Recheck of the merge of PR #58, problem 1: the guard stays on the page after the call returns, and says when the run
// behind it is over so that the person's own navigation can take the page back (electron/browser-service.ts).
describe('u06-1: the guard says when its run is over', () => {
  it('not while the run is going, though the call has returned', async () => {
    const h = harness([4000])
    h.setAnswer('allow')
    await h.call('navigate', { url: localUrl })
    expect(h.guardOver()).toBe(false)
  })

  it('once the run has ended or been stopped; the guard itself still refuses', async () => {
    const h = harness([4000])
    h.setAnswer('allow')
    await h.call('navigate', { url: localUrl })
    h.endRun()
    expect(h.guardOver()).toBe(true)
    await expect(h.authorize('http://127.0.0.1:3000/next')).rejects.toThrow('The browser run ended or was stopped')
  })

  it('once the caller has hung up', async () => {
    const hangUp = new AbortController()
    const h = harness([4000], () => undefined, hangUp)
    h.setAnswer('allow')
    await h.call('navigate', { url: localUrl })
    expect(h.guardOver()).toBe(false)
    hangUp.abort()
    expect(h.guardOver()).toBe(true)
  })
})
