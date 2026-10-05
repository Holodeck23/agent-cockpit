import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StoreReadError } from '../server/state/read-error.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const meta = (id: string) => ({ id, title: id.slice(0, 4), projectPath: '/tmp', settings: threadSettingsSchema.parse({}), sessionId: id,
  sessionStarted: false, completed: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })

describe('thread store with one damaged conversation (ID-02)', () => {
  it('lists the others, refuses the damaged one by name, and never rewrites it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-thread-store-'))
    const store = createThreadStore(root)
    const good = '11111111-2222-4333-8444-555555555555'
    const bad = '99999999-2222-4333-8444-555555555555'
    store.create(meta(good))
    mkdirSync(join(root, 'threads', bad))
    const damaged = '{"id":"9999'
    writeFileSync(join(root, 'threads', bad, 'meta.json'), damaged)
    expect(store.list().map((m) => m.id)).toEqual([good])
    expect(() => store.get(bad)).toThrow(StoreReadError)
    expect(() => store.update(bad, { title: 'x' })).toThrow(StoreReadError)
    expect(readFileSync(join(root, 'threads', bad, 'meta.json'), 'utf8')).toBe(damaged)
    expect(store.get(good)?.title).toBe('1111')
  })
})
