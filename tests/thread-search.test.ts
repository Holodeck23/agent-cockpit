import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { searchThreads } from '../server/threads/search.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { startServer } from '../server/start.ts'

function seeded() {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-search-')))
  const add = (title: string, projectPath: string, events: NormalizedEvent[]): string => {
    const ts = new Date().toISOString()
    const meta = store.create({ id: randomUUID(), title, projectPath, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed: false, createdAt: ts, updatedAt: ts })
    for (const event of events) store.append(meta.id, event, ts)
    return meta.id
  }
  const a = add('Bakery', '/w/bakery', [{ kind: 'user_text', text: 'Fix the invoice totals' }, { kind: 'assistant_text', messageId: 'm1', text: 'The rounding in invoice.ts was off by one cent.' }])
  const b = add('Clinic', '/w/clinic', [{ kind: 'user_text', text: 'Add a checklist' }, { kind: 'assistant_text', messageId: 'm2', text: 'Done. No invoices here.' }])
  return { store, a, b }
}

describe('searching every message', () => {
  it('finds conversations whose messages contain every word, with an excerpt', () => {
    const { store, a, b } = seeded()
    const hits = searchThreads(store, 'rounding cent')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id: a })
    expect(hits[0]!.excerpt).toBe('The rounding in invoice.ts was off by one cent.')
    expect(searchThreads(store, 'INVOICE').map((h) => h.id).sort()).toEqual([a, b].sort())
    expect(searchThreads(store, 'invoice', '/w/clinic').map((h) => h.id)).toEqual([b])
  })
  it('ignores tiny or empty queries and finds nothing for absent words', () => {
    const { store } = seeded()
    expect(searchThreads(store, ' ')).toEqual([])
    expect(searchThreads(store, 'a')).toEqual([])
    expect(searchThreads(store, 'zebra')).toEqual([])
  })
  it('is served at /api/threads/search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-search-state-'))
    const server = await startServer({ port: 0, stateRoot: root, webDist: root })
    try {
      const res = await fetch(`${server.url}/api/threads/search?q=nothing-here`)
      expect(res.status).toBe(200)
      expect((await res.json()).data).toEqual([])
      expect((await fetch(`${server.url}/api/threads/search?q=${'x'.repeat(300)}`)).status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
