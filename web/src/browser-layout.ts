// What the in-app browser remembers per page (W9.1): the last safe address, desktop or mobile
// width, the pane's width, whether it was expanded and whether it was open. Nothing else: no
// form fields, screenshots or history. Kept in this browser's storage, one record per page key.

export type ViewportMode = 'desktop' | 'mobile'

export interface PaneLayout {
  readonly url: string
  readonly mode: ViewportMode
  readonly width: number
  readonly expanded: boolean
  readonly visible: boolean
}

export type LayoutMap = Readonly<Record<string, PaneLayout>>

export const MIN_PANE_WIDTH = 360
/** The narrowest the pane gets when the window cannot fit it at MIN_PANE_WIDTH beside the chat. */
export const TIGHT_PANE_WIDTH = 340
export const DEFAULT_PANE_WIDTH = 520
/** Mobile mode is a responsive-layout preview at this CSS width, not device emulation. */
export const MOBILE_WIDTH = 390
/** Expand leaves the conversation at least this wide, so it stays reachable. */
export const CHAT_MIN_WIDTH = 420
/** In a window too narrow for both minimums, the conversation still keeps this much. */
export const CHAT_TIGHT_WIDTH = 380
const STORAGE_KEY = 'cockpit:browser-layout'
const MAX_PAGES = 200

const safeUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value) && value.length <= 8192

/** Reads stored layouts, dropping any record that is not exactly the expected shape. */
export function parseLayouts(raw: string | null): LayoutMap {
  if (!raw) return {}
  let data: unknown
  try { data = JSON.parse(raw) } catch { return {} }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const out: Record<string, PaneLayout> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const v = value as Partial<PaneLayout> | null
    if (!v || !safeUrl(v.url) || (v.mode !== 'desktop' && v.mode !== 'mobile') || typeof v.width !== 'number' || !Number.isFinite(v.width)) continue
    out[key] = { url: v.url, mode: v.mode, width: Math.max(MIN_PANE_WIDTH, Math.round(v.width)), expanded: v.expanded === true, visible: v.visible === true }
  }
  return out
}

export function loadLayouts(): LayoutMap {
  try { return parseLayouts(localStorage.getItem(STORAGE_KEY)) } catch { return {} }
}

export function saveLayouts(layouts: LayoutMap): void {
  const keys = Object.keys(layouts)
  const kept = keys.length > MAX_PAGES ? Object.fromEntries(keys.slice(-MAX_PAGES).map((k) => [k, layouts[k]])) : layouts
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)) } catch { /* storage unavailable: layouts last this session */ }
}

/** Opening a page: a new record, or the existing one shown with this address (its width and mode kept). */
export function openPage(layouts: LayoutMap, key: string, url: string): LayoutMap {
  const prior = layouts[key]
  return { ...layouts, [key]: { url, mode: prior?.mode ?? 'desktop', width: prior?.width ?? DEFAULT_PANE_WIDTH, expanded: prior?.expanded ?? false, visible: true } }
}

/** Any change to one page's record; only a safe http(s) address replaces the remembered one. */
export function updatePage(layouts: LayoutMap, key: string, change: Partial<PaneLayout>): LayoutMap {
  const prior = layouts[key]
  if (!prior) return layouts
  const url = change.url !== undefined && safeUrl(change.url) ? change.url : prior.url
  const width = change.width !== undefined ? Math.max(MIN_PANE_WIDTH, Math.round(change.width)) : prior.width
  return { ...layouts, [key]: { ...prior, ...change, url, width } }
}

/**
 * The pane's width, given the room the conversation and the pane share (the window less the
 * conversation list): its own width, or (expanded) everything but the conversation's minimum.
 * When both minimums do not fit, the shortfall is split: the conversation keeps 380, the pane 340.
 */
export function paneWidth(layout: PaneLayout, available: number): number {
  const roomy = available - CHAT_MIN_WIDTH
  const most = roomy >= MIN_PANE_WIDTH ? roomy : Math.max(TIGHT_PANE_WIDTH, Math.min(MIN_PANE_WIDTH, available - CHAT_TIGHT_WIDTH))
  return layout.expanded ? most : Math.min(layout.width, most)
}
