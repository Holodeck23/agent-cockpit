import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createImageStore, IMAGE_FILE, ImageAttachError, MAX_ATTACHED_IMAGE_BYTES } from '../server/threads/images.ts'
import type { AgentSession, EventSink } from '../server/agents/types.ts'
import { startServer } from '../server/start.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])
const THREAD = '11111111-2222-3333-4444-555555555555'
const roots: string[] = []
const store = () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-images-'))
  roots.push(root)
  return { root, images: createImageStore(root) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('conversation image store', () => {
  it('stores an image by its content hash under the state folder, private to this user', () => {
    const { root, images } = store()
    const saved = images.save(THREAD, PNG)
    expect(saved.file).toMatch(IMAGE_FILE)
    expect(saved.file.endsWith('.png')).toBe(true)
    expect(saved.mediaType).toBe('image/png')
    expect(saved.path).toBe(join(root, 'attachments', THREAD, saved.file))
    expect(readFileSync(saved.path).equals(PNG)).toBe(true)
    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
    // The same bytes twice are one file.
    expect(images.save(THREAD, PNG).file).toBe(saved.file)
  })

  it('goes by the bytes, not a name: refuses SVG, text and empty files', () => {
    const { images } = store()
    expect(() => images.save(THREAD, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(ImageAttachError)
    expect(() => images.save(THREAD, Buffer.from('hello'))).toThrow(ImageAttachError)
    expect(() => images.save(THREAD, Buffer.alloc(0))).toThrow(ImageAttachError)
  })

  it('refuses an image over 5 MB', () => {
    const { images } = store()
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHED_IMAGE_BYTES)])
    expect(() => images.save(THREAD, big)).toThrow(/5 MB/)
  })

  it('reads back only well-formed names inside that conversation', () => {
    const { images } = store()
    const saved = images.save(THREAD, PNG)
    expect(images.read(THREAD, saved.file)?.mediaType).toBe('image/png')
    expect(images.read(THREAD, `../${saved.file}`)).toBeUndefined()
    expect(images.read(THREAD, saved.file.replace('.png', '.svg'))).toBeUndefined()
    expect(images.read('22222222-2222-3333-4444-555555555555', saved.file)).toBeUndefined()
    expect(() => images.read('../etc', saved.file)).toThrow()
  })

  it('removes a conversation’s images with it', () => {
    const { images } = store()
    const saved = images.save(THREAD, PNG)
    images.remove(THREAD)
    expect(existsSync(saved.path)).toBe(false)
  })
})

describe('GET /api/threads/:id/images/:file', () => {
  it('serves a stored image as exactly its type, and nothing else', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-images-http-'))
    roots.push(stateRoot)
    let emit: EventSink = () => undefined
    const launcher = (_request: unknown, onEvent: EventSink): AgentSession => {
      emit = onEvent
      return { agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined, close: () => Promise.resolve(), alive: () => true }
    }
    const server = await startServer({ port: 0, stateRoot, webDist: stateRoot, launchers: { claude: launcher } })
    try {
      const created = await fetch(`${server.url}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath: stateRoot, text: 'draw' }) })
      const { data: meta } = await created.json() as { data: { id: string } }
      await new Promise((resolve) => setTimeout(resolve, 0))
      emit({ kind: 'image_data', source: { data: PNG.toString('base64') } })
      const image = server.store.events(meta.id).map((e) => e.event).find((e) => e.kind === 'image')
      expect(image?.kind).toBe('image')
      const file = (image as { file: string }).file
      const ok = await fetch(`${server.url}/api/threads/${meta.id}/images/${file}`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('image/png')
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true)
      for (const bad of [file.replace('.png', '.svg'), 'a.png', `..%2F${file}`, file.toUpperCase()]) {
        expect((await fetch(`${server.url}/api/threads/${meta.id}/images/${bad}`)).status, bad).toBe(404)
      }
      expect((await fetch(`${server.url}/api/threads/22222222-2222-3333-4444-555555555555/images/${file}`)).status).toBe(404)
      // Another site's page cannot read it.
      expect((await fetch(`${server.url}/api/threads/${meta.id}/images/${file}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    } finally {
      await server.close()
    }
  })
})

describe('POST images with a message (I2)', () => {
  it('takes them on create and send, and refuses one that is not an image', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-images-post-'))
    roots.push(stateRoot)
    const sent: Array<{ text: string; images?: unknown }> = []
    const launcher = (_request: unknown, _onEvent: EventSink): AgentSession =>
      ({ agent: 'claude', send: (text, _q, images) => { sent.push({ text, images }) }, respondApproval: () => undefined, interrupt: () => undefined, close: () => Promise.resolve(), alive: () => true })
    const server = await startServer({ port: 0, stateRoot, webDist: stateRoot, launchers: { claude: launcher } })
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const created = await post('/api/threads', { projectPath: stateRoot, text: 'what is this?', images: [{ data: PNG.toString('base64'), name: 'a.png' }] })
      expect(created.status).toBe(201)
      const { data: meta } = await created.json() as { data: { id: string } }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(server.store.events(meta.id).filter((e) => e.event.kind === 'image')).toHaveLength(1)
      // A screenshot-sized message (several MB) fits; the 1 MB cap stays everywhere else.
      const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString('base64')
      expect((await post(`/api/threads/${meta.id}/messages`, { text: 'and this', images: [{ data: big }] })).status).toBe(202)
      expect((await post(`/api/threads/${meta.id}/messages`, { text: 'svg', images: [{ data: Buffer.from('<svg/>').toString('base64') }] })).status).toBe(400)
      expect((await post(`/api/threads/${meta.id}/messages`, { text: 'many', images: Array.from({ length: 9 }, () => ({ data: PNG.toString('base64') })) })).status).toBe(400)
      expect((await post(`/api/threads/${meta.id}/completed`, { completed: true, pad: 'x'.repeat(1_100_000) })).status).toBe(413)
      expect(sent.map((s) => s.text)).toEqual(['what is this?', 'and this'])
    } finally {
      await server.close()
    }
  })
})
