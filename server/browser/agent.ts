import type { ApprovalBehavior } from '../agents/types.ts'
import { HttpError, parseBody } from '../http/json.ts'
import type { McpGrant } from '../mcp/sessions.ts'
import type { HostActionOptions } from '../threads/host-actions.ts'
import { browserInputs, INPUT_OPERATIONS, originClass, originOf, pageKeyOf, type BrowserLeases, type BrowserOperation } from './agent-policy.ts'

// Agents driving the in-app browser (H3, wave 9). The host (electron/browser-agent-host.ts) owns
// the pages; this decides, for every call, which page, whether it may happen, and whether the
// person has to approve it first. The scope is derived here from the session grant: the caller's
// conversation, its current run, its workspace and its own page. Nothing in the request widens it.

export interface Viewport { readonly width: number; readonly height: number }

/** What every browser response carries, so the agent always knows which page state it acted on. */
export interface AgentPageInfo {
  readonly pageId: string
  readonly revision: number
  readonly url: string
  readonly origin: string
  readonly title: string
  readonly loading: boolean
  readonly viewport: Viewport
  readonly timestamp: string
  readonly error?: { readonly code: number; readonly description: string; readonly url: string }
}

export interface PageElement {
  readonly ref: string
  readonly role: string
  readonly name: string
  /** CSS pixels in the viewport: the element's box. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PageRead {
  readonly page: AgentPageInfo
  readonly text: string
  readonly elements: readonly PageElement[]
  readonly scroll: { readonly x: number; readonly y: number }
  readonly truncated: boolean
}

export type AgentInput =
  | { readonly kind: 'click' | 'hover'; readonly ref?: string; readonly x?: number; readonly y?: number }
  | { readonly kind: 'type'; readonly ref?: string; readonly x?: number; readonly y?: number; readonly text: string }
  | { readonly kind: 'key'; readonly key: string; readonly modifiers?: readonly string[] }
  | { readonly kind: 'scroll'; readonly x?: number; readonly y?: number; readonly dx: number; readonly dy: number }
  | { readonly kind: 'drag'; readonly from: { x: number; y: number }; readonly to: { x: number; y: number }; readonly steps: number }

export type ActOutcome =
  | { readonly outcome: 'done'; readonly detail: string; readonly page: AgentPageInfo }
  | { readonly outcome: 'stale' | 'gone' | 'covered' | 'outside'; readonly detail: string; readonly page: AgentPageInfo }

export interface Capture { readonly data: string; readonly mimeType: 'image/png'; readonly width: number; readonly height: number; readonly page: AgentPageInfo }

/** The pages, as the desktop app's main process holds them. */
export interface BrowserHost {
  info(key: string): AgentPageInfo | undefined
  /**
   * Creates the conversation's page (hidden, in the workspace's partition) when it has none: blank,
   * or reloaded at its last address if Cockpit unloaded it. Rejects when every loaded page is in use.
   */
  ensure(key: string, projectPath: string): Promise<AgentPageInfo>
  /** Loads `url`; resolves when it has loaded, failed, or a bounded wait has passed. */
  goto(key: string, url: string): Promise<AgentPageInfo>
  /** Where Back or Forward would go, if anywhere. */
  historyUrl(key: string, direction: 'back' | 'forward'): string | undefined
  history(key: string, action: 'back' | 'forward' | 'reload'): Promise<AgentPageInfo>
  read(key: string): Promise<PageRead>
  capture(key: string): Promise<Capture>
  /** Dispatches only if the page is still at `expect` (revision and origin) right before it does. Never retried. */
  act(key: string, input: AgentInput, expect: { readonly revision: number; readonly origin: string }): Promise<ActOutcome>
}

export interface BrowserAgentDeps {
  readonly host: () => BrowserHost | undefined
  readonly leases: BrowserLeases
  readonly cockpitPorts: () => readonly number[]
  /** The run the conversation is on now; undefined when it is not working or Stop was pressed. */
  /** The run working now in the grant's workspace (W12-15: a conversation can have one per workspace). */
  readonly currentRun: (threadId: string, workspaceId?: string) => string | undefined
  /** Whether that run of the conversation is still working, in whichever workspace. */
  readonly runActive?: (threadId: string, runId: string) => boolean
  /** Asks the person in the conversation; rejects on Deny, expiry, Stop or the caller hanging up. */
  readonly approve: (grant: McpGrant, toolName: string, input: Record<string, unknown>, options: HostActionOptions, signal: AbortSignal) => Promise<ApprovalBehavior>
}

const APPROVAL_SECONDS = 45

const ACTION_WORDS: Record<BrowserOperation, string> = {
  read: 'Read the page', screenshot: 'Take a screenshot of the page', navigate: 'Open a page',
  click: 'Click', hover: 'Move the pointer over', type: 'Type', key: 'Press a key', scroll: 'Scroll', drag: 'Drag',
}

const hostOf = (origin: string): string => { try { return new URL(origin).host } catch { return origin } }

export function createBrowserAgent(deps: BrowserAgentDeps) {
  /**
   * Requires a grant for `origin` on this run, asking the person when there is none. "Allow" lets
   * this one action through; "Allow on <site> for this run" also leaves a grant for the run.
   * Deny, expiry or a hang-up removes every grant the conversation had.
   */
  async function permit(grant: McpGrant, runId: string, op: BrowserOperation, origin: string, summary: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const scope = { threadId: grant.threadId, runId, pageKey: pageKeyOf(grant.threadId), origin }
    if (deps.leases.has(scope)) return
    const host = hostOf(origin)
    const local = originClass(origin, deps.cockpitPorts()) === 'local'
    const warning = op === 'read' || op === 'screenshot'
      ? 'The agent will see what this page shows, including anything you are signed in to.'
      : op === 'navigate' ? 'Opening a page can act on a site (a link can sign you up, buy or delete).'
      : 'Clicks, keys and forms on a website can act for you: send, buy, delete.'
    let behavior: ApprovalBehavior
    try {
      behavior = await deps.approve(grant, `mcp__cockpit__browser_${op}`, { page: 'This conversation’s browser', origin, ...summary }, {
        label: 'Browser action',
        timeoutMs: APPROVAL_SECONDS * 1000,
        description: `${ACTION_WORDS[op]} in this conversation’s browser on ${local ? `your local app (${host})` : host}. ${warning} Answer within ${APPROVAL_SECONDS} seconds.`,
        grant: { label: `Allow on ${host} for this run` },
      }, signal)
    } catch (error) {
      deps.leases.revokeThread(grant.threadId)
      throw new HttpError(409, error instanceof Error ? error.message : String(error))
    }
    // The approval took time: the run may have ended or been stopped meanwhile.
    if (deps.currentRun(grant.threadId, grant.workspaceId) !== runId) throw new HttpError(409, 'The run that asked has ended; nothing was done.')
    if (behavior === 'allow_session') deps.leases.grant(scope)
  }

  /** May the agent see a page at `url` without asking? Local apps yes, remote sites only with a grant. */
  const seeable = (grant: McpGrant, runId: string, url: string): boolean => {
    const kind = originClass(url, deps.cockpitPorts())
    if (kind === 'local' || url === 'about:blank') return true
    const origin = originOf(url)
    return kind === 'remote' && origin !== undefined && deps.leases.has({ threadId: grant.threadId, runId, pageKey: pageKeyOf(grant.threadId), origin })
  }

  /** Calls in flight per page, including any waiting on the person: such a page is never unloaded. */
  const active = new Map<string, number>()

  async function handle(grant: McpGrant, op: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const key = pageKeyOf(grant.threadId)
    active.set(key, (active.get(key) ?? 0) + 1)
    try {
      return await operate(grant, op, body, signal)
    } finally {
      const left = (active.get(key) ?? 1) - 1
      if (left > 0) active.set(key, left)
      else active.delete(key)
    }
  }

  async function operate(grant: McpGrant, op: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    // Own keys only: "toString" or "constructor" are not operations.
    if (!Object.hasOwn(browserInputs, op)) throw new HttpError(404, 'Not found')
    const operation = op as BrowserOperation
    const host = deps.host()
    if (!host) throw new HttpError(503, 'The in-app browser is only available in the Cockpit desktop app')
    const input = parseBody(browserInputs[operation] as never, body ?? {}) as Record<string, unknown>
    const key = pageKeyOf(grant.threadId)
    // Never says whether another page exists: only that this one is the caller's.
    if (input.pageId !== undefined && input.pageId !== key) throw new HttpError(403, 'That is not this conversation’s page. Use the pageId your own browser calls return.')
    const runId = deps.currentRun(grant.threadId, grant.workspaceId)
    if (!runId) throw new HttpError(409, 'This conversation is not working (or Stop was pressed), so it cannot use the browser now.')
    deps.leases.keepRun(grant.threadId, runId)
    const ports = deps.cockpitPorts()

    if (operation === 'read' || operation === 'screenshot') {
      const page = await ensure(host, key, grant.cwd)
      if (!seeable(grant, runId, page.url)) await permit(grant, runId, operation, page.origin, { url: page.url }, signal)
      const result = operation === 'read' ? await conflict(host.read(key)) : await conflict(host.capture(key))
      // The page moved to another site while it was being read: that site needs its own grant.
      const after = result.page.url
      if (after !== page.url && !seeable(grant, runId, after) && originOf(after) !== page.origin) {
        throw new HttpError(409, `The page moved to ${originOf(after) ?? after} while it was being read; read it again.`)
      }
      return result
    }

    if (operation === 'navigate') {
      await ensure(host, key, grant.cwd)
      const { url, action } = input as { url?: string; action?: 'back' | 'forward' | 'reload' }
      const target = url ?? (action === 'reload' ? host.info(key)?.url : host.historyUrl(key, action as 'back' | 'forward'))
      if (!target) throw new HttpError(409, `There is no page to go ${action} to.`)
      const kind = originClass(target, ports)
      if (kind === 'refused') throw new HttpError(400, `The browser opens http and https sites only, never Cockpit itself: ${target.slice(0, 200)}`)
      if (kind === 'remote') await permit(grant, runId, 'navigate', originOf(target)!, { url: target, ...(action ? { action } : {}) }, signal)
      return url ? host.goto(key, url) : host.history(key, action!)
    }

    // Input: always needs a grant for the page's exact origin, local app or not.
    const page = host.info(key)
    if (!page || !originOf(page.url)) throw new HttpError(409, 'This conversation has no page open. Open one with browser_navigate first.')
    if (originClass(page.url, ports) === 'refused') throw new HttpError(409, 'This page cannot be operated.')
    const act = toInput(operation, input)
    await permit(grant, runId, operation, page.origin, { url: page.url, ...summarize(act) }, signal)
    return host.act(key, act, { revision: input.revision as number, origin: page.origin })
  }

  return {
    handle,
    /** Busy with a call, or granted to a run that is still going (W9-10 keeps such a page loaded). */
    inUse(pageKey: string): boolean {
      return (active.get(pageKey) ?? 0) > 0 || deps.leases.list().some((l) => l.pageKey === pageKey
        && (deps.runActive ? deps.runActive(l.threadId, l.runId) : deps.currentRun(l.threadId) === l.runId))
    },
  }
}
export type BrowserAgent = ReturnType<typeof createBrowserAgent>

async function ensure(host: BrowserHost, key: string, folder: string): Promise<AgentPageInfo> {
  return conflict(host.ensure(key, folder))
}
/** A host refusal (the page is gone, full, or changed while it was read) is a 409 with its own words. */
async function conflict<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : String(error))
  }
}

function toInput(op: BrowserOperation, input: Record<string, unknown>): AgentInput {
  if (!INPUT_OPERATIONS.includes(op)) throw new HttpError(404, 'Not found')
  const { pageId: _pageId, revision: _revision, ...rest } = input
  return { kind: op, ...rest } as AgentInput
}

/** What the approval card shows of an input action: never the typed text, only its length. */
function summarize(input: AgentInput): Record<string, unknown> {
  const { kind, ...rest } = input
  if (kind === 'type') {
    const { text, ...target } = rest as { text: string }
    return { action: kind, ...target, characters: text.length }
  }
  return { action: kind, ...rest }
}
