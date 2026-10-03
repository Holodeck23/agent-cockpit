// The tab bar's order: pinned projects in the order they were pinned, then the active project
// if it isn't pinned. Pins from before pin order existed keep their old alphabetical place, first.

interface Tabbable { readonly path: string; readonly name: string; readonly pinned: boolean; readonly pinOrder?: number }

export function tabOrder<P extends Tabbable>(projects: readonly P[], activePath: string | undefined): P[] {
  const byName = (a: P, b: P): number => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  const pinned = projects.filter((p) => p.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0) || byName(a, b))
  const loose = projects.find((p) => !p.pinned && p.path === activePath)
  return loose ? [...pinned, loose] : pinned
}
