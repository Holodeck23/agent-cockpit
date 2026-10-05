import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventSink } from '../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore, type ThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema, type ThreadMeta } from '../server/threads/types.ts'

// The log is read incrementally (H2): only what was appended since the last read is parsed.

const meta = (): ThreadMeta => {
  const now = new Date().toISOString()
  return { id: randomUUID(), title: 't', projectPath: '/tmp', settings: threadSettingsSchema.parse({}), completed: false, createdAt: now, updatedAt: now } as ThreadMeta
}
const texts = (store: ThreadStore, id: string) => store.events(id).map((e) => (e.event.kind === 'user_text' ? e.event.text : e.event.kind))

describe('reading a conversation log incrementally', () => {
  it('sees appends from another writer, a line completed later, and a log that was replaced', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-incremental-'))
    const store = createThreadStore(root)
    const other = createThreadStore(root)
    const m = store.create(meta())
    const log = join(root, 'threads', m.id, 'events.jsonl')
    store.append(m.id, { kind: 'user_text', text: 'one' })
    expect(texts(store, m.id)).toEqual(['one'])
    other.append(m.id, { kind: 'user_text', text: 'two' })
    expect(texts(store, m.id)).toEqual(['one', 'two'])
    // Half a line is not read until it is complete.
    const line = JSON.stringify({ ts: new Date().toISOString(), event: { kind: 'user_text', text: 'three' } })
    appendFileSync(log, line.slice(0, 20))
    expect(texts(store, m.id)).toEqual(['one', 'two'])
    appendFileSync(log, `${line.slice(20)}\n`)
    expect(texts(store, m.id)).toEqual(['one', 'two', 'three'])
    // A log replaced or shrunk is read whole again.
    rmSync(log)
    writeFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), event: { kind: 'user_text', text: 'fresh' } })}\n`)
    expect(texts(store, m.id)).toEqual(['fresh'])
  })

  it('hands out a copy, so a caller holding events never sees them change', () => {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-incremental-')))
    const m = store.create(meta())
    store.append(m.id, { kind: 'user_text', text: 'one' })
    const held = store.events(m.id)
    store.append(m.id, { kind: 'user_text', text: 'two' })
    expect(held).toHaveLength(1)
    expect(store.events(m.id)).toHaveLength(2)
  })

  it('does not read the log for a streamed token', () => {
    const real = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-incremental-')))
    let reads = 0
    const store: ThreadStore = { ...real, events: (id) => { reads++; return real.events(id) } }
    let emit: EventSink = () => {}
    const launcher: Launcher = (_r, onEvent) => { emit = onEvent; return { agent: 'claude', send() {}, interrupt() {}, respondApproval() {}, alive: () => true, close: async () => onEvent({ kind: 'exit', code: 0 }) } }
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    const statuses: string[] = []
    manager.subscribe((u) => statuses.push(u.status))
    const t = manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'hello' })
    emit({ kind: 'session', sessionId: t.sessionId })
    const before = reads
    for (let i = 0; i < 200; i++) emit({ kind: 'text_delta', text: 'x' })
    expect(reads).toBe(before)
    expect(statuses.at(-1)).toBe('working')
    emit({ kind: 'result', ok: true })
    expect(statuses.at(-1)).not.toBe('working')
  })
})
