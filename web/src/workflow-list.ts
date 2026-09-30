// Search, views and collections for the workflow list. Pure, so it's unit-tested.
import type { Workflow } from './api.ts'

export type WorkflowView = 'all' | 'scheduled' | 'manual'
type Row = Pick<Workflow, 'name' | 'title' | 'collection' | 'prompt' | 'enabled'>

export const displayTitle = (w: Pick<Workflow, 'name' | 'title'>): string => w.title || w.name

/** Every word of the query must appear in the title, name, collection or instructions. */
export function filterWorkflows<T extends Row>(rows: readonly T[], query: string, view: WorkflowView): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((w) => {
    if (view === 'scheduled' && !w.enabled) return false
    if (view === 'manual' && w.enabled) return false
    const haystack = `${displayTitle(w)} ${w.name} ${w.collection ?? ''} ${w.prompt}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Named collections alphabetically, then the ungrouped ones; titles sorted within each. */
export function groupByCollection<T extends Row>(rows: readonly T[]): Array<{ collection: string | undefined; rows: T[] }> {
  const groups = new Map<string | undefined, T[]>()
  for (const row of rows) groups.set(row.collection || undefined, [...(groups.get(row.collection || undefined) ?? []), row])
  const byTitle = (a: T, b: T): number => displayTitle(a).localeCompare(displayTitle(b))
  return [...groups.entries()]
    .sort(([a], [b]) => (a === undefined ? 1 : b === undefined ? -1 : a.localeCompare(b)))
    .map(([collection, list]) => ({ collection, rows: [...list].sort(byTitle) }))
}
