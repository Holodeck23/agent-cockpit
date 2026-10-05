import { createHash } from 'node:crypto'
import { isLoopbackHost } from '../server/browser/address.ts'

export { addressToUrl } from '../server/browser/address.ts'

// Host policy for the in-app browser (H2, wave 9). Pure functions, so the rules are testable
// without Electron; electron/browser-service.ts applies them to every page, request and navigation.

const MIN_SIDE = 120

const portOf = (url: URL): number => Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80))

/** A request is Cockpit's own when it targets one of Cockpit's listener ports on any loopback name. */
function isCockpit(url: URL, cockpitPorts: readonly number[]): boolean {
  return isLoopbackHost(url.hostname) && cockpitPorts.includes(portOf(url))
}

/**
 * Any request a browser page makes: documents, subresources, redirects, workers, sockets.
 * Web traffic and the person's own local dev servers pass; Cockpit's listeners and privileged or
 * local-file schemes never do.
 */
export function isAllowedRequest(raw: string, cockpitPorts: readonly number[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol === 'blob:' || url.protocol === 'data:') return true
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
  return !isCockpit(url, cockpitPorts)
}

/** A top-level page load: http(s) only, never Cockpit. */
export function isNavigable(raw: string, cockpitPorts: readonly number[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !isCockpit(url, cockpitPorts)
}

export interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The pane's rectangle as the page reports it: finite, inside the window, not a sliver. */
export function validBounds(value: unknown, content: { readonly width: number; readonly height: number }): Bounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const left = Math.max(0, Math.round(x as number))
  const top = Math.max(0, Math.round(y as number))
  const right = Math.min(content.width, Math.round((x as number) + (width as number)))
  const bottom = Math.min(content.height, Math.round((y as number) + (height as number)))
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** One page per conversation (`thread:<id>`) or per project process slot (`project:<absolute path>`). */
export function pageKeyOk(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4100 && /^(thread:[\w-]{1,80}|project:\/[^\0]*)$/.test(value)
}

/**
 * Website data lives per workspace folder, in a persistent partition of its own: never the
 * control session, never another workspace's. Named by a hash so a path never appears in it.
 */
export function partitionFor(workspacePath: string): string {
  return `persist:cockpit-web-${createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)}`
}

// ---------- agent input (H3): pure pieces of electron/browser-agent-host.ts ----------

/** The revision an element ref belongs to ("e12-3" → 12), or undefined for anything else. */
export function refParts(ref: string): { revision: number; index: number } | undefined {
  const match = /^e(\d{1,12})-(\d{1,4})$/.exec(ref)
  return match ? { revision: Number(match[1]), index: Number(match[2]) } : undefined
}

/** A point in CSS pixels must fall inside the page's current viewport. */
export function insideViewport(x: number, y: number, viewport: { readonly width: number; readonly height: number }): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < viewport.width && y < viewport.height
}

/** The pointer positions of a drag after the press: `steps` even moves ending exactly at `to`. */
export function dragPath(from: { x: number; y: number }, to: { x: number; y: number }, steps: number): Array<{ x: number; y: number }> {
  const n = Math.max(1, Math.min(20, Math.floor(steps)))
  return Array.from({ length: n }, (_, i) => ({ x: Math.round(from.x + ((to.x - from.x) * (i + 1)) / n), y: Math.round(from.y + ((to.y - from.y) * (i + 1)) / n) }))
}

/** The tool's key names as Electron's sendInputEvent spells them, and the character a key types. */
export const KEY_EVENTS: Readonly<Record<string, { readonly keyCode: string; readonly char?: string }>> = {
  Enter: { keyCode: 'Enter', char: '\r' }, Tab: { keyCode: 'Tab' }, Escape: { keyCode: 'Escape' },
  Backspace: { keyCode: 'Backspace' }, Delete: { keyCode: 'Delete' }, Space: { keyCode: 'Space', char: ' ' },
  ArrowUp: { keyCode: 'Up' }, ArrowDown: { keyCode: 'Down' }, ArrowLeft: { keyCode: 'Left' }, ArrowRight: { keyCode: 'Right' },
  Home: { keyCode: 'Home' }, End: { keyCode: 'End' }, PageUp: { keyCode: 'PageUp' }, PageDown: { keyCode: 'PageDown' },
}
