import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApprovalBehavior } from '../../server/agents/types.ts'
import { createBrowserAgent, type AgentPageInfo, type BrowserHost } from '../../server/browser/agent.ts'
import { createBrowserLeases, originOf } from '../../server/browser/agent-policy.ts'
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
const signal = new AbortController().signal

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
 * through whenever the real isNavigable() (electron/browser-policy.ts) says yes. It records every URL the
 * page actually requested, so we can see what went out.
 */
function harness(cockpitPorts: number[]) {
  let url = 'about:blank'
  let revision = 1
  const requested: string[] = []
  const asked: Array<{ tool: string; input: Record<string, unknown> }> = []
  let answer: ApprovalBehavior | 'deny' = 'deny'
  const page = (): AgentPageInfo => ({ pageId: 'thread:t1', revision, url, origin: originOf(url) ?? 'null', title: '', loading: false, viewport: { width: 800, height: 600 }, timestamp: 'now' })
  let authorize: (url: string) => Promise<void> = async () => {}
  const host: BrowserHost = {
    guardNavigation: (_key, guard) => { authorize = guard },
    info: () => page(),
    ensure: async () => page(),
    goto: async (_key, target) => {
      let next = target
      for (let hop = 0; hop < 5; hop++) {
        await authorize(next)
        requested.push(next)
        url = next
        if (originOf(next) !== originOf(localUrl)) break // the "remote site": nothing to fetch, it has been requested
        const res = await fetch(next, { redirect: 'manual' })
        const location = res.headers.get('location')
        if (res.status < 300 || res.status >= 400 || !location) break
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
    currentRun: () => 'r1',
    approve: async (_grant, tool, input) => {
      asked.push({ tool, input })
      if (answer === 'deny') throw new Error('Browser action denied by the user')
      return answer
    },
  })
  return { call: (op: string, body: unknown = {}) => agent.handle(grant, op, body, signal), requested, asked, setAnswer: (a: ApprovalBehavior | 'deny') => { answer = a } }
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
