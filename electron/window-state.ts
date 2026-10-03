import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The window reopens at the size and place it was left, as long as that place is still on a
// screen. Pure apart from the file, so the placement rules are unit-tested without Electron.

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState extends Rect { maximized: boolean }
export interface WindowDefaults { width: number; height: number; minWidth: number; minHeight: number }
export interface Placement { bounds: Partial<Rect> & { width: number; height: number }; maximized: boolean }

const TITLE_BAR = 30

export function readWindowState(file: string): WindowState | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const { x, y, width, height, maximized } = value
    const numbers = [x, y, width, height]
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
    return { x: x as number, y: y as number, width: width as number, height: height as number, maximized: maximized === true }
  } catch {
    return undefined
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state)}\n`)
  } catch {
    // Only costs the next launch its remembered place; never block on it.
  }
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(n, high))

/**
 * Where to open: the saved bounds on the screen that holds most of the title bar (so the window
 * can always be dragged), shrunk to fit it. No such screen means the default size, centred.
 */
export function placeWindow(saved: WindowState | undefined, workAreas: readonly Rect[], defaults: WindowDefaults): Placement {
  const fallback: Placement = { bounds: { width: defaults.width, height: defaults.height }, maximized: saved?.maximized ?? false }
  if (!saved) return fallback
  const titleBar: Rect = { x: saved.x, y: saved.y, width: saved.width, height: TITLE_BAR }
  const area = [...workAreas].sort((a, b) => overlap(titleBar, b) - overlap(titleBar, a))[0]
  if (!area || overlap(titleBar, area) === 0) return fallback
  const width = Math.max(defaults.minWidth, Math.min(saved.width, area.width))
  const height = Math.max(defaults.minHeight, Math.min(saved.height, area.height))
  const x = clamp(saved.x, area.x, Math.max(area.x, area.x + area.width - width))
  const y = clamp(saved.y, area.y, Math.max(area.y, area.y + area.height - height))
  return { bounds: { x, y, width, height }, maximized: saved.maximized }
}
