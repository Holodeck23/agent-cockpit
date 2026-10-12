import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkflowList } from '../../web/src/components/WorkflowList.tsx'

// u28-3: saving a workflow switches its schedule off. A repeating job saved or paused with "Every 30 min"
// was labelled Manual above that very line, while a days-and-time one in the same state said Paused.

const row = (over: object) => ({ id: 'w', name: 'nightly', title: 'Nightly', prompt: 'do it', enabled: false, calendar: null, intervalMinutes: null, lastError: null, ...over })
const badge = (w: object): string | undefined => {
  const html = renderToStaticMarkup(createElement(WorkflowList, {
    project: { name: 'p', path: '/p' } as never, rows: [row(w)] as never, loaded: true, selected: undefined, busy: false,
    onSelect: () => {}, onCreate: () => {}, galleryOpen: false, onOpenGallery: () => {},
  }))
  return /<small class="workflow-status[^"]*">([^<]*)<\/small>/.exec(html)?.[1]
}

describe('the status badge of a switched-off workflow', () => {
  it('says Paused when it has an interval schedule', () => {
    expect(badge({ intervalMinutes: 30 })).toBe('Paused')
  })
  it('says Paused when it has a days-and-time schedule', () => {
    expect(badge({ calendar: { days: [1], time: '09:00', timeZone: 'UTC' } })).toBe('Paused')
  })
  it('says Manual when it has no schedule', () => {
    expect(badge({})).toBe('Manual')
  })
  it('says Scheduled when it is on', () => {
    expect(badge({ intervalMinutes: 30, enabled: true })).toBe('Scheduled')
  })
})
