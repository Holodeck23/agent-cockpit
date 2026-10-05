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
