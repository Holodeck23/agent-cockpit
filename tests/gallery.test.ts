import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkflowStore, workflowInputSchema } from '../server/workflows/store.ts'
import { CATEGORIES, GALLERY } from '../web/src/gallery/catalog.ts'
import { categoryCounts, copyInput, featured, freeName, inCategory, needsSentence, relatedTo, scheduleLabel, searchGallery } from '../web/src/gallery/gallery.ts'

const project = mkdtempSync(join(tmpdir(), 'cockpit-gallery-project-'))
const entry = (name: string) => GALLERY.find((w) => w.name === name)!

describe('gallery catalogue', () => {
  it('has unique names that save as valid workflows', () => {
    expect(new Set(GALLERY.map((w) => w.name)).size).toBe(GALLERY.length)
    for (const w of GALLERY) expect(() => workflowInputSchema.parse(copyInput(w, project, new Set(), 'Europe/London'))).not.toThrow()
  })

  it('fills every category and features a few', () => {
    for (const c of CATEGORIES) expect(inCategory(GALLERY, c).length).toBeGreaterThan(1)
    expect(featured().length).toBeGreaterThanOrEqual(3)
    expect(featured().length).toBeLessThanOrEqual(5)
  })

  it('favours the repository: only the outside-the-repo category needs tools, and those say so', () => {
    const outside = GALLERY.filter((w) => w.needs?.length)
    expect(outside.length).toBeLessThan(GALLERY.length / 4)
    for (const w of outside) {
      expect(w.category).toBe('Mail, calendar and web')
      expect(w.prompt).toMatch(/say (so|which) and stop/)
    }
  })

  it('keeps read-only jobs on Plan and anything that runs or edits on asking first', () => {
    for (const w of GALLERY) expect(['plan', 'manual']).toContain(w.permissionMode)
    expect(entry('lint-tidy').permissionMode).toBe('manual')
    expect(entry('focused-review').permissionMode).toBe('plan')
  })
})

describe('browsing', () => {
  it('searches every word across title, summary, category, tools and instructions', () => {
    expect(searchGallery('calendar').every((w) => w.needs?.includes('Calendar') || w.category.includes('calendar'))).toBe(true)
    expect(searchGallery('changelog tag').map((w) => w.name)).toEqual(['changelog-draft'])
    expect(searchGallery('GITHUB cli').map((w) => w.name)).toEqual(['issue-triage'])
    expect(searchGallery('no such workflow anywhere')).toEqual([])
  })

  it('counts All, then each category in catalogue order, for the current matches', () => {
    const counts = categoryCounts(GALLERY)
    expect(counts[0]).toEqual({ category: 'All', count: GALLERY.length })
    expect(counts.slice(1).map((c) => c.category)).toEqual([...CATEGORIES])
    expect(counts.slice(1).reduce((n, c) => n + c.count, 0)).toBe(GALLERY.length)
    const narrowed = categoryCounts(searchGallery('commit'))
    expect(narrowed[0]!.count).toBe(searchGallery('commit').length)
  })

  it('relates the same category first, then featured picks, never itself', () => {
    const related = relatedTo(entry('commit-message'))
    expect(related).toHaveLength(3)
    expect(related.every((w) => w.category === 'Git and handoffs' && w.name !== 'commit-message')).toBe(true)
    const fewer = relatedTo(entry('build-report'), 4)
    expect(fewer.map((w) => w.category)).toEqual(['Run and debug', 'Run and debug', expect.any(String), expect.any(String)])
    expect(fewer.slice(2).every((w) => w.featured)).toBe(true)
  })

  it('labels schedules and tools in words', () => {
    expect(scheduleLabel(entry('standup-notes'))).toBe('Weekdays at 09:00')
    expect(scheduleLabel(entry('week-in-review'))).toBe('Mon at 09:00')
    expect(scheduleLabel(entry('focused-review'))).toBe('On demand')
    expect(needsSentence(['Calendar', 'Mail'])).toBe('read access to your calendar and read access to your email')
    expect(needsSentence(['Browser'])).toBe('a browser tool')
  })
})

describe('adding', () => {
  it('never collides with an existing name', () => {
    expect(freeName('focused-review', new Set())).toBe('focused-review')
    expect(freeName('focused-review', new Set(['focused-review', 'focused-review-2']))).toBe('focused-review-3')
  })

  it('saves a paused copy: the suggested schedule is filled in but off, nothing runs', () => {
    const store = createWorkflowStore(mkdtempSync(join(tmpdir(), 'cockpit-gallery-')))
    const copy = store.save(copyInput(entry('standup-notes'), project, new Set(), 'Europe/Vienna'))
    expect(copy).toMatchObject({ name: 'standup-notes', title: 'Standup notes', collection: 'Git and handoffs', enabled: false, nextRunAt: null,
      intervalMinutes: null, calendar: { days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Europe/Vienna' } })
    expect(copy.settings.permissionMode).toBe('plan')
    expect(copy.lastThreadId).toBeUndefined()
    const again = store.save(copyInput(entry('standup-notes'), project, new Set(store.list(project).map((w) => w.name)), 'Europe/Vienna'))
    expect(again.name).toBe('standup-notes-2')
  })

  it('leaves on-demand copies without any schedule', () => {
    expect(copyInput(entry('focused-review'), project, new Set(), 'UTC')).toMatchObject({ intervalMinutes: null, calendar: null })
  })
})
