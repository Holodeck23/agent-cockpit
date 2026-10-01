import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, parseAppearance, rowMeta } from '../web/src/appearance.ts'

describe('appearance', () => {
  it('defaults to the original look when nothing or garbage is stored', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearance('[1,2]')).toEqual(DEFAULT_APPEARANCE)
    expect(DEFAULT_APPEARANCE).toEqual({ list: 'normal', messages: 'normal', rows: { preview: false, agent: true, date: true } })
  })

  it('keeps each valid field and defaults the rest', () => {
    expect(parseAppearance(JSON.stringify({ list: 'compact', messages: 'huge', rows: { preview: true, date: 'no' } })))
      .toEqual({ list: 'compact', messages: 'normal', rows: { preview: true, agent: true, date: true } })
  })

  it('builds the row line from the parts it is set to show', () => {
    const parts = { agent: 'Claude Code', date: 'Today' }
    expect(rowMeta(parts, DEFAULT_APPEARANCE.rows)).toBe('Claude Code · Today')
    expect(rowMeta(parts, { preview: false, agent: false, date: true })).toBe('Today')
    expect(rowMeta({ ...parts, project: 'Bakery' }, { preview: false, agent: true, date: false })).toBe('Bakery · Claude Code')
    expect(rowMeta(parts, { preview: true, agent: false, date: false })).toBe('')
  })
})
