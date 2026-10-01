// Browsing the gallery and copying from it. Pure, so it's unit-tested.
import type { WorkflowInput } from '../api.ts'
import { describeCalendar } from '../../../server/workflows/calendar.ts'
import { CATEGORIES, GALLERY, type Category, type GalleryWorkflow, type Tool } from './catalog.ts'

export type CategoryFilter = Category | 'All'

/** Every word of the query must appear in the title, summary, category, tools or instructions. */
export function searchGallery(query: string, entries: readonly GalleryWorkflow[] = GALLERY): GalleryWorkflow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((w) => {
    const haystack = `${w.title} ${w.name} ${w.summary} ${w.category} ${(w.needs ?? []).join(' ')} ${w.prompt}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** "All" first, then each category in catalogue order with how many of `entries` it holds. */
export function categoryCounts(entries: readonly GalleryWorkflow[]): Array<{ category: CategoryFilter; count: number }> {
  return [{ category: 'All' as const, count: entries.length },
    ...CATEGORIES.map((category) => ({ category, count: entries.filter((w) => w.category === category).length }))]
}

export const inCategory = (entries: readonly GalleryWorkflow[], category: CategoryFilter): GalleryWorkflow[] =>
  category === 'All' ? [...entries] : entries.filter((w) => w.category === category)

export const featured = (entries: readonly GalleryWorkflow[] = GALLERY): GalleryWorkflow[] => entries.filter((w) => w.featured)

export const findGallery = (name: string): GalleryWorkflow | undefined => GALLERY.find((w) => w.name === name)

/** Up to `limit` others: the same category first, then the featured picks. */
export function relatedTo(entry: GalleryWorkflow, limit = 3, entries: readonly GalleryWorkflow[] = GALLERY): GalleryWorkflow[] {
  const others = entries.filter((w) => w.name !== entry.name)
  const picks = [...others.filter((w) => w.category === entry.category), ...others.filter((w) => w.featured && w.category !== entry.category)]
  return picks.slice(0, limit)
}

/** "Weekdays at 09:00", or "On demand" when it has no suggested schedule. */
export const scheduleLabel = (entry: Pick<GalleryWorkflow, 'schedule'>): string =>
  entry.schedule ? describeCalendar({ days: [...entry.schedule.days], time: entry.schedule.time }) : 'On demand'

const TOOL_NOTE: Record<Tool, string> = {
  Mail: 'read access to your email',
  Calendar: 'read access to your calendar',
  Browser: 'a browser tool',
  'GitHub CLI': 'the GitHub CLI (gh), signed in',
}

/** What the agent must already have, in words: "read access to your calendar and read access to your email". */
export function needsSentence(tools: readonly Tool[]): string {
  const notes = tools.map((t) => TOOL_NOTE[t])
  return notes.length <= 1 ? notes.join('') : `${notes.slice(0, -1).join(', ')} and ${notes.at(-1)}`
}

/** A slug not already taken in the project: "focused-review", then "focused-review-2", … */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/**
 * What "Add to Workflows" saves: a copy under a free reference name, filed under its category.
 * A suggested schedule is filled in, in the Mac's timezone; the store saves every copy paused,
 * so it never runs until someone turns its schedule on or runs it.
 */
export function copyInput(entry: GalleryWorkflow, projectPath: string, taken: ReadonlySet<string>, timeZone: string): WorkflowInput {
  return {
    projectPath, name: freeName(entry.name, taken), title: entry.title, collection: entry.category, prompt: entry.prompt,
    intervalMinutes: null,
    calendar: entry.schedule ? { days: [...entry.schedule.days], time: entry.schedule.time, timeZone } : null,
    settings: { agent: 'claude', permissionMode: entry.permissionMode, useHooks: false },
  }
}
