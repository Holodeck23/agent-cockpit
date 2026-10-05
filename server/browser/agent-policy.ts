import { z } from 'zod'
import type { NormalizedEvent } from '../agents/types.ts'
import { isLoopbackHost } from './address.ts'

// Rules for agents driving the in-app browser (H3, wave 9). Pure, so they are tested without
// Electron; server/browser/agent.ts applies them to every browser_* call.

/** A conversation's own page. The server derives it from the session grant, never from the request. */
export const pageKeyOf = (threadId: string): string => `thread:${threadId}`

const portOf = (url: URL): number => Number(url.port || (url.protocol === 'https:' ? 443 : 80))

/**
 * Where a page or address sits for agent policy. `local`: the person's own app on this Mac
 * (loopback http(s), not Cockpit), the existing low-friction preview. `remote`: any other
 * http(s) site. `refused`: everything else (Cockpit itself, file:, javascript:, custom schemes).
 */
export function originClass(raw: string, cockpitPorts: readonly number[]): 'local' | 'remote' | 'refused' {
  let url: URL
  try { url = new URL(raw) } catch { return 'refused' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'refused'
  if (!isLoopbackHost(url.hostname)) return 'remote'
  return cockpitPorts.includes(portOf(url)) ? 'refused' : 'local'
}

/** The exact origin a grant names: scheme, host and port. */
export function originOf(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

export interface LeaseScope {
  readonly threadId: string
  readonly runId: string
  readonly pageKey: string
  readonly origin: string
}

const leaseKey = (s: LeaseScope): string => [s.threadId, s.runId, s.pageKey, s.origin].join('\n')

/**
 * Browser grants: one run of one conversation, on its own page, for one exact origin. Any end of
 * the run, a Deny, a Stop or the page going away removes them; nothing carries into the next run.
 */
export function createBrowserLeases() {
  const leases = new Map<string, LeaseScope>()
  const drop = (test: (s: LeaseScope) => boolean): number => {
    let dropped = 0
    for (const [key, scope] of [...leases]) if (test(scope)) { leases.delete(key); dropped++ }
    return dropped
  }
  return {
    grant(scope: LeaseScope): void { leases.set(leaseKey(scope), scope) },
    has(scope: LeaseScope): boolean { return leases.has(leaseKey(scope)) },
    /** Every grant of a conversation that does not belong to `runId` (the run it is on now, if any). */
    keepRun(threadId: string, runId: string | undefined): number { return drop((s) => s.threadId === threadId && s.runId !== runId) },
    revokeThread(threadId: string): number { return drop((s) => s.threadId === threadId) },
    revokePage(pageKey: string): number { return drop((s) => s.pageKey === pageKey) },
    list(): readonly LeaseScope[] { return [...leases.values()] },
  }
}
export type BrowserLeases = ReturnType<typeof createBrowserLeases>

// ---------- tool inputs: strict, so a forged run or page field is refused rather than ignored ----------

const pageId = z.string().max(200).optional().describe('Optional: the pageId a previous browser call returned. Only this conversation’s own page is accepted.')
const revision = z.number().int().min(0).describe('The page revision from your latest browser_read or browser_screenshot. A stale revision is refused, never retried.')
const coordinate = z.number().finite().min(0).max(10_000)
const ref = z.string().regex(/^e\d{1,12}-\d{1,4}$/).describe('An element ref from browser_read at this revision, e.g. "e12-3"')
/** A point by element ref, or by CSS pixel within the viewport. */
const target = { ref: ref.optional(), x: coordinate.optional(), y: coordinate.optional() }
const hasTarget = (v: { ref?: string; x?: number; y?: number }): boolean =>
  v.ref !== undefined ? v.x === undefined && v.y === undefined : v.x !== undefined && v.y !== undefined
const TARGET_MESSAGE = 'Give either ref, or both x and y (CSS pixels in the viewport), not both.'

export const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const
export const MODIFIERS = ['shift', 'alt', 'control', 'meta'] as const
export const MAX_TYPED = 2000
export const MAX_DRAG_STEPS = 20

export const browserInputs = {
  read: z.object({ pageId }).strict(),
  screenshot: z.object({ pageId }).strict(),
  navigate: z.object({
    pageId,
    url: z.string().min(1).max(4000).optional().describe('An http(s) address to open in this conversation’s page'),
    action: z.enum(['back', 'forward', 'reload']).optional(),
  }).strict().refine((v) => Boolean(v.url) !== Boolean(v.action), 'Give either url or action'),
  click: z.object({ pageId, revision, ...target }).strict().refine(hasTarget, TARGET_MESSAGE),
  hover: z.object({ pageId, revision, ...target }).strict().refine(hasTarget, TARGET_MESSAGE),
  type: z.object({
    pageId, revision, ...target,
    text: z.string().min(1).max(MAX_TYPED).describe('Text to type. Cockpit keeps only its length, never the text.'),
  }).strict().refine((v) => (v.ref === undefined && v.x === undefined && v.y === undefined) || hasTarget(v), 'To type into an element give ref, or both x and y; with none, types into the focused element.'),
  key: z.object({ pageId, revision, key: z.enum(KEYS), modifiers: z.array(z.enum(MODIFIERS)).max(4).optional() }).strict(),
  scroll: z.object({
    pageId, revision,
    x: coordinate.optional(), y: coordinate.optional(),
    dx: z.number().finite().min(-5000).max(5000).default(0),
    dy: z.number().finite().min(-5000).max(5000).default(0),
  }).strict(),
  drag: z.object({
    pageId, revision,
    from: z.object({ x: coordinate, y: coordinate }).strict(),
    to: z.object({ x: coordinate, y: coordinate }).strict(),
    steps: z.number().int().min(1).max(MAX_DRAG_STEPS).default(8),
  }).strict(),
} as const

export type BrowserOperation = keyof typeof browserInputs
export const BROWSER_OPERATIONS = Object.keys(browserInputs) as BrowserOperation[]
export const INPUT_OPERATIONS: readonly BrowserOperation[] = ['click', 'hover', 'type', 'key', 'scroll', 'drag']

// ---------- typed text never persists ----------

export const BROWSER_TYPE_TOOL = 'mcp__cockpit__browser_type'

/** What the log keeps of a browser_type call: its target and length, never the text. */
export function redactTyped(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const { text, ...rest } = input as Record<string, unknown>
  return typeof text === 'string' ? { ...rest, characters: text.length } : rest
}

/**
 * Applied to every event before Cockpit stores or shows it: the agent's own record of a
 * browser_type call (tool use, approval card, helper progress) carries no typed text.
 */
export function redactBrowserEvent(event: NormalizedEvent): NormalizedEvent {
  if (event.kind === 'tool_use' && event.name === BROWSER_TYPE_TOOL) return { ...event, input: redactTyped(event.input) }
  if (event.kind === 'approval_request' && event.toolName === BROWSER_TYPE_TOOL) return { ...event, input: redactTyped(event.input) }
  if (event.kind === 'subagent' && event.tool?.name === BROWSER_TYPE_TOOL) return { ...event, tool: { ...event.tool, input: redactTyped(event.tool.input) } }
  return event
}
