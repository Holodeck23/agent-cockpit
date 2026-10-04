import { randomBytes } from 'node:crypto'
import type { BrowserWindow, OnBeforeSendHeadersListenerDetails, Session } from 'electron'
import { WINDOW_KEY_HEADER } from '../server/http/guard.ts'

// Only the Cockpit window can use the desktop API (server/http/guard.ts). The key is made at
// each launch and lives in this process's memory only: not in env, argv, a file or the preload,
// so neither the page nor an agent's shell can read it. The header is added here, on the way out.

export function createWindowKey(): string {
  return randomBytes(32).toString('hex')
}

/** What decides whether one request gets the key; split out so it is testable without Electron. */
export interface KeyedRequest {
  readonly url: string
  readonly webContentsId?: number
  /** The requesting frame, or null when Chromium cannot name one. */
  readonly frame: { readonly processId: number; readonly routingId: number; readonly url: string } | null
}
export interface MainFrame {
  readonly webContentsId: number
  readonly processId: number
  readonly routingId: number
}

/**
 * True only for Cockpit's own /api, asked for by the main window's own top frame while it shows
 * Cockpit's page. That excludes the preview pane (an iframe), the hidden window that captures a
 * preview for an agent (a separate BrowserWindow with its own top frame), and a request Chromium
 * cannot tie to a frame.
 */
export function shouldCarryKey(request: KeyedRequest, main: MainFrame | undefined, origin: string): boolean {
  if (!main || request.webContentsId !== main.webContentsId || !request.frame) return false
  if (request.frame.processId !== main.processId || request.frame.routingId !== main.routingId) return false
  try {
    const target = new URL(request.url)
    return target.origin === origin && target.pathname.startsWith('/api/') && new URL(request.frame.url).origin === origin
  } catch {
    return false
  }
}

function frameOf(details: OnBeforeSendHeadersListenerDetails): KeyedRequest['frame'] {
  try {
    const frame = details.frame
    return frame ? { processId: frame.processId, routingId: frame.routingId, url: frame.url } : null
  } catch {
    // A frame that has gone away throws on access; such a request gets no key.
    return null
  }
}

function mainFrameOf(win: BrowserWindow | undefined): MainFrame | undefined {
  if (!win || win.isDestroyed()) return undefined
  const frame = win.webContents.mainFrame
  return { webContentsId: win.webContents.id, processId: frame.processId, routingId: frame.routingId }
}

/**
 * NOTE: Electron keeps ONE onBeforeSendHeaders listener per session. Registering another anywhere
 * on this session silently replaces this one, and every API call from the window then gets 403.
 * `mainWindow` is read per request, because the window can be closed and reopened.
 */
export function installWindowKey(session: Session, origin: string, key: string, mainWindow: () => BrowserWindow | undefined): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    // Never let a page supply its own value, keyed or not.
    for (const name of Object.keys(headers)) if (name.toLowerCase() === WINDOW_KEY_HEADER) delete headers[name]
    const request = { url: details.url, webContentsId: details.webContentsId, frame: frameOf(details) }
    if (shouldCarryKey(request, mainFrameOf(mainWindow()), origin)) headers[WINDOW_KEY_HEADER] = key
    callback({ requestHeaders: headers })
  })
}
