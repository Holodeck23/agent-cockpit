import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventSink } from '../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// W9.3: text an agent types into a web page persists only as a redacted summary, in every log
// Cockpit keeps (stored events, the transcript file, live updates), not just in the UI.

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : [path]
})

describe('browser_type redaction', () => {
  it('never stores or broadcasts the typed text', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-redaction-'))
    const store = createThreadStore(root)
    let sink: EventSink = () => {}
    const launcher: Launcher = (_request, emit) => {
      sink = emit
      return { agent: 'claude', alive: () => true, send() {}, interrupt() {}, respondApproval() {}, close: async () => {} }
    }
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    const broadcast: string[] = []
    manager.subscribe((update) => broadcast.push(JSON.stringify(update)))
    const thread = manager.create({ projectPath: root, text: 'sign me in', settings: threadSettingsSchema.parse({}) })
    const secret = 'pa55word-only-for-the-site'
    sink({ kind: 'tool_use', id: 'u1', name: 'mcp__cockpit__browser_type', input: { revision: 3, ref: 'e3-1', text: secret } })
    sink({ kind: 'tool_result', toolUseId: 'u1', content: '{"outcome":"done","detail":"Typed 26 characters"}', isError: false })
    sink({ kind: 'result', ok: true })

    const stored = store.events(thread.id).map((e) => e.event)
    expect(stored.find((e) => e.kind === 'tool_use')).toMatchObject({ input: { ref: 'e3-1', characters: secret.length } })
    for (const file of files(root)) expect(readFileSync(file, 'utf8'), file).not.toContain(secret)
    expect(broadcast.join('\n')).not.toContain(secret)
  })
})
