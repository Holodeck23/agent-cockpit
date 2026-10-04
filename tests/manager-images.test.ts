import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink, OutgoingImage } from '../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a tiny png')])

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-img-'))
  const store = createThreadStore(root)
  const agent = { emit: (() => undefined) as EventSink, sent: [] as Array<{ text: string; images?: readonly OutgoingImage[] }> }
  const launcher: Launcher = (_request, onEvent) => {
    agent.emit = onEvent
    let alive = true
    const session: AgentSession = {
      agent: 'claude',
      send: (text, _queuedId, images) => { agent.sent.push({ text, ...(images ? { images } : {}) }) },
      respondApproval: () => undefined,
      interrupt: () => undefined,
      close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() },
      alive: () => alive,
    }
    return session
  }
  const manager = createThreadManager(store, { launchers: { claude: launcher } })
  return { root, store, manager, agent, settings: threadSettingsSchema.parse({}) }
}

const kinds = (store: ReturnType<typeof createThreadStore>, id: string) => store.events(id).map((e) => e.event)

describe('images the agent shows', () => {
  it('saves the bytes and records an image event, never the bytes themselves', () => {
    const { root, store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'draw' })
    agent.emit({ kind: 'image_data', source: { data: PNG.toString('base64') }, name: 'chart.png' })
    const image = kinds(store, meta.id).find((e) => e.kind === 'image')
    expect(image).toMatchObject({ kind: 'image', from: 'agent', mediaType: 'image/png', name: 'chart.png' })
    expect(kinds(store, meta.id).some((e) => e.kind === 'image_data')).toBe(false)
    const log = readFileSync(join(root, 'threads', meta.id, 'events.jsonl'), 'utf8')
    expect(log).not.toContain(PNG.toString('base64'))
    expect(existsSync(join(root, 'attachments', meta.id, (image as { file: string }).file))).toBe(true)
  })

  it('copies an image file the agent looked at', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'look' })
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-seen-')), 'shot.png')
    writeFileSync(file, PNG)
    agent.emit({ kind: 'image_data', source: { path: file } })
    expect(kinds(store, meta.id).find((e) => e.kind === 'image')).toMatchObject({ from: 'agent', name: 'shot.png' })
  })

  it('drops what is not an image (or is gone) without breaking the turn', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'look' })
    agent.emit({ kind: 'image_data', source: { data: Buffer.from('<svg/>').toString('base64') } })
    agent.emit({ kind: 'image_data', source: { path: '/nonexistent/shot.png' } })
    agent.emit({ kind: 'assistant_text', messageId: 'm', text: 'done' })
    expect(kinds(store, meta.id).map((e) => e.kind)).toEqual(['session_boundary', 'user_text', 'assistant_text'])
  })

  it('deletes a conversation’s images with the conversation', async () => {
    const { root, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'draw' })
    agent.emit({ kind: 'image_data', source: { data: PNG.toString('base64') } })
    await manager.remove(meta.id)
    expect(existsSync(join(root, 'attachments', meta.id))).toBe(false)
  })
})
