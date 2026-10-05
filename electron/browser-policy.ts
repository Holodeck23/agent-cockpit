import { createHash } from 'node:crypto'

// Host policy for the in-app browser (H2, wave 9). Pure functions, so the rules are testable
// without Electron; electron/browser-service.ts applies them to every page, request and navigation.

const MIN_SIDE = 120

/** True for every way a URL can name this machine: Chromium resolves all of these to loopback. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
    || host === '[::1]' || host === '[::]' || host === '[::ffff:7f00:1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
}

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

/**
 * What the person typed in the address field, as a URL to load, or undefined when it is not an
 * http(s) address. A bare host gets https, except local hosts and IP addresses, which get http.
 */
export function addressToUrl(input: string): string | undefined {
  const text = input.trim()
  if (!text || /\s/.test(text)) return undefined
  const schemed = /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d/.test(text)
  let url: URL
  try {
    if (schemed) url = new URL(text)
    else {
      const host = text.split(/[/:?#]/)[0]!
      const local = isLoopbackHost(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)
      if (!local && !host.includes('.')) return undefined
      url = new URL(`${local ? 'http' : 'https'}://${text}`)
    }
  } catch { return undefined }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
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
