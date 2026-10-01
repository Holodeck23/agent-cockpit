import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryStore, recallText } from '../server/memory/store.ts'

const store = () => createMemoryStore(mkdtempSync(join(tmpdir(), 'cockpit-memory-')))

describe('memory', () => {
  it('keeps project entries to their project and shares everywhere entries', () => {
    const m = store()
    m.add({ scope: 'project', projectPath: '/a', text: 'Deploys go to staging first.', source: { kind: 'conversation', threadId: 't1' } })
    m.add({ scope: 'everywhere', projectPath: '/a', text: 'Prefers pnpm over npm.', source: { kind: 'you' } })
    expect(m.list('/a').map((e) => e.text).sort()).toEqual(['Deploys go to staging first.', 'Prefers pnpm over npm.'])
    expect(m.list('/b').map((e) => e.text)).toEqual(['Prefers pnpm over npm.'])
    expect(m.list('/b')[0]?.projectPath).toBeUndefined()
  })

  it('searches by shared words, best match first, and lists the newest for an empty query', () => {
    const m = store()
    m.add({ scope: 'project', projectPath: '/a', text: 'The staging deploy uses the blue cluster.', source: { kind: 'you' } })
    m.add({ scope: 'project', projectPath: '/a', text: 'Logo colour is teal.', source: { kind: 'you' } })
    expect(m.search('/a', 'which cluster for staging deploy?').map((e) => e.text)).toEqual(['The staging deploy uses the blue cluster.'])
    expect(m.search('/a', 'nothing related')).toEqual([])
    expect(m.search('/a', '', 1)).toHaveLength(1)
  })

  it('edits, deletes and clears a project without touching everywhere entries', () => {
    const m = store()
    const a = m.add({ scope: 'project', projectPath: '/a', text: 'Old fact.', source: { kind: 'you' } })
    m.add({ scope: 'project', projectPath: '/a', text: 'Another.', source: { kind: 'you' } })
    m.add({ scope: 'everywhere', projectPath: '/a', text: 'Kept.', source: { kind: 'you' } })
    expect(m.update(a.id, 'New fact.').text).toBe('New fact.')
    m.remove(a.id)
    expect(() => m.remove(a.id)).toThrow(/Unknown/)
    expect(m.clearProject('/a')).toBe(1)
    expect(m.list('/a').map((e) => e.text)).toEqual(['Kept.'])
    expect(() => m.add({ scope: 'project', projectPath: '/a', text: '   ', source: { kind: 'you' } })).toThrow()
  })

  it('recalls with dates, origins and a reminder that memory ages', () => {
    const m = store()
    m.add({ scope: 'project', projectPath: '/a', text: 'Port 5173.', source: { kind: 'conversation', threadId: 't9' } })
    const text = recallText(m.search('/a', 'port'))
    expect(text).toMatch(/may be out of date/)
    expect(text).toMatch(/^- \[\d{4}-\d{2}-\d{2}, this project, from a conversation\] Port 5173\.$/m)
    expect(recallText([])).toMatch(/Nothing in Cockpit memory matches/)
  })
})
