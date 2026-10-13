// The tab bar's order: pinned projects in the order they were pinned, then the active project
// if it isn't pinned. Pins from before pin order existed keep their old alphabetical place, first.

interface Tabbable { readonly path: string; readonly name: string; readonly pinned: boolean; readonly pinOrder?: number }

export function tabOrder<P extends Tabbable>(projects: readonly P[], activePath: string | undefined): P[] {
  const byName = (a: P, b: P): number => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  const pinned = projects.filter((p) => p.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0) || byName(a, b))
  const loose = projects.find((p) => !p.pinned && p.path === activePath)
  return loose ? [...pinned, loose] : pinned
}

/** The order after moving the item at `from` to `to` (both indexes in the original list). Never mutates. */
export function moveTab<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items]
  const rest = items.filter((_, i) => i !== from)
  return [...rest.slice(0, to), items[from]!, ...rest.slice(to)]
}

/** Where a dragged tab lands among the OTHER tabs (their boxes, left to right): how many of their middles lie left of `x`. */
export function dropIndex(others: ReadonlyArray<{ left: number; width: number }>, x: number): number {
  return others.filter((r) => r.left + r.width / 2 < x).length
}

/** The tab to show after closing `path`: the one after it, else the one before, else none. */
export function nextAfterClose<P extends { readonly path: string }>(tabs: readonly P[], path: string): P | undefined {
  const i = tabs.findIndex((t) => t.path === path)
  if (i < 0) return undefined
  return tabs[i + 1] ?? tabs[i - 1]
}
