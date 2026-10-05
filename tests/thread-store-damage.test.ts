import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startServer } from '../server/start.ts'
import { createThreadStore } from '../server/threads/store.ts'
import type { ThreadMeta } from '../server/threads/types.ts'
import { StoreReadError } from '../server/state/read-error.ts'

// A crash, a power cut or a full disk can leave half a line in events.jsonl or a meta.json that
// does not parse. One damaged conversation must not hide the others (H3).

const metaFor = (projectPath: string, title = 'A conversation'): ThreadMeta => {
  const now = new Date().toISOString()
  return { id: randomUUID(), title, projectPath, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
    completed: false, createdAt: now, updatedAt: now } as ThreadMeta
}

describe('a damaged conversation on disk', () => {
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errors.mockRestore() })

  it('skips half a line at the end of the log and keeps every whole event', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-damage-'))
    const store = createThreadStore(root)
    const meta = store.create(metaFor('/tmp'))
    store.append(meta.id, { kind: 'user_text', text: 'first' })
    appendFileSync(join(root, 'threads', meta.id, 'events.jsonl'), '{"ts":"2026-10-05T00:00:00.000Z","event":{"kind":"assis')
    expect(store.events(meta.id).map((e) => e.event.kind)).toEqual(['user_text'])
    // An unfinished last line may still be being written: it is left out, not yet called damaged.
    expect(errors).not.toHaveBeenCalled()
    // Once a new event follows it, it is a damaged line: skipped and reported once.
    store.append(meta.id, { kind: 'user_text', text: 'second' })
    expect(store.events(meta.id).map((e) => e.event.kind)).toEqual(['user_text', 'user_text'])
    store.events(meta.id)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('starts the next event on a fresh line instead of joining it to the half line', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-damage-'))
    const meta = createThreadStore(root).create(metaFor('/tmp'))
    const log = join(root, 'threads', meta.id, 'events.jsonl')
    writeFileSync(log, `${JSON.stringify({ ts: '2026-10-05T00:00:00.000Z', event: { kind: 'user_text', text: 'before the crash' } })}\n{"ts":"2026`)
    // A new process, as after the crash that cut the line short.
    const store = createThreadStore(root)
    store.append(meta.id, { kind: 'user_text', text: 'after the crash' })
    store.append(meta.id, { kind: 'user_text', text: 'and again' })
    expect(store.events(meta.id).map((e) => (e.event.kind === 'user_text' ? e.event.text : ''))).toEqual(['before the crash', 'after the crash', 'and again'])
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
  })

  it('skips lines that parse but are not events', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-damage-'))
    const store = createThreadStore(root)
    const meta = store.create(metaFor('/tmp'))
    appendFileSync(join(root, 'threads', meta.id, 'events.jsonl'), 'null\n42\n{"ts":1}\n')
    store.append(meta.id, { kind: 'user_text', text: 'kept' })
    expect(store.events(meta.id)).toHaveLength(1)
  })

  it('leaves a conversation with a damaged meta.json out of the list, on disk and untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-damage-'))
    const store = createThreadStore(root)
    const good = store.create(metaFor('/tmp', 'Good'))
    const bad = store.create(metaFor('/tmp', 'Bad'))
    const file = join(root, 'threads', bad.id, 'meta.json')
    writeFileSync(file, '{"id":')
    expect(store.list().map((m) => m.id)).toEqual([good.id])
    expect(() => store.get(bad.id)).toThrow(StoreReadError)
    expect(readFileSync(file, 'utf8')).toBe('{"id":')
  })

  it('still lists every other conversation over the API', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-damage-state-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-damage-project-'))
    const seed = createThreadStore(stateRoot)
    const good = seed.create(metaFor(project, 'Good'))
    seed.append(good.id, { kind: 'user_text', text: 'hello' })
    const torn = seed.create(metaFor(project, 'Torn log'))
    appendFileSync(join(stateRoot, 'threads', torn.id, 'events.jsonl'), '{"ts":"2026-10-05T00:00:00.000Z","ev')
    const broken = seed.create(metaFor(project, 'Broken meta'))
    writeFileSync(join(stateRoot, 'threads', broken.id, 'meta.json'), '')
    const server = await startServer({ port: 0, stateRoot, webDist: project })
    try {
      const response = await fetch(`${server.url}/api/threads`)
      expect(response.status).toBe(200)
      const rows = (await response.json()).data as Array<{ meta: ThreadMeta; messageCount: number }>
      expect(rows.map((r) => r.meta.title).sort()).toEqual(['Good', 'Torn log'])
      expect((await fetch(`${server.url}/api/threads/${torn.id}/events`)).status).toBe(200)
    } finally { await server.close() }
  })
})
