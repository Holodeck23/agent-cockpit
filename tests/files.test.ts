import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandFiles, listFiles, readProjectFile } from '../server/files/browser.ts'
import { describeAttachments, MessageReferenceError } from '../server/files/references.ts'
import { buildHandoff } from '../server/threads/handoff.ts'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-files-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'hello world.ts'), 'export const greeting = "hello"\n')
  writeFileSync(join(root, 'README.md'), '# Sample project\n')
  return root
}

describe('project files', () => {
  it('lists folders before files, hides dependencies, and reads names with spaces', () => {
    const root = fixture(); mkdirSync(join(root, 'node_modules'))
    const list = listFiles(root)
    expect(list.entries.map((e) => e.name)).toEqual(['src', 'README.md'])
    expect(listFiles(root, 'src').entries[0]?.path).toBe('src/hello world.ts')
    expect(expandFiles('@file:src%2Fhello%20world.ts', root)).toContain('export const greeting')
  })
  it('blocks traversal, absolute paths and symlinks outside the project', () => {
    const root = fixture(); const outside = fixture()
    symlinkSync(outside, join(root, 'outside'))
    expect(() => listFiles(root, '../')).toThrow(/inside the project/)
    expect(() => readProjectFile(root, join(outside, 'README.md'))).toThrow(/inside the project/)
    expect(() => readProjectFile(root, 'outside/README.md')).toThrow(/inside the project/)
    expect(listFiles(root).entries.some((e) => e.name === 'outside')).toBe(false)
    expect(() => expandFiles('@file:%2e%2e%2fREADME.md', root)).toThrow(/inside the project/)
  })
  it('rejects non-text files, directories and oversized files', () => {
    const root = fixture()
    writeFileSync(join(root, 'binary.bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]))
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(100_001))
    expect(() => readProjectFile(root, 'src')).toThrow(/text file/)
    expect(() => readProjectFile(root, 'binary.bin')).toThrow(/Binary/)
    expect(() => readProjectFile(root, 'invalid.txt')).toThrow(/UTF-8/)
    expect(() => readProjectFile(root, 'large.txt')).toThrow(/100 KB/)
  })
  it('bounds aggregate attachments and never expands references inside file contents', () => {
    const root = fixture()
    writeFileSync(join(root, 'reference.txt'), '@file:missing.txt @workflow:missing')
    expect(expandFiles('@file:reference.txt', root)).toContain('@file:missing.txt @workflow:missing')
    expect(() => expandFiles('@file:README.md '.repeat(9), root)).toThrow(/at most 8/)
    writeFileSync(join(root, 'long.txt'), 'x'.repeat(90_000))
    expect(() => expandFiles('@file:long.txt '.repeat(3), root)).toThrow(/200,000/)
  })
  it('serves registered project files and sends expanded contents to the agent', async () => {
    const root = fixture(); const messages: string[] = []
    const launcher: Launcher = (_request, emit) => ({ agent: 'codex', alive: () => true,
      send: (text) => { messages.push(text) }, respondApproval() {}, interrupt() {},
      close: async () => { emit({ kind: 'exit', code: 0 }) } })
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-files-state-')), webDist: root,
      launchers: { claude: launcher, codex: launcher } })
    try {
      const post = (path: string, body: unknown) => fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const url = `${server.url}/api/files?${new URLSearchParams({ projectPath: root })}`
      expect((await fetch(url)).status).toBe(404)
      await post('projects', { path: root })
      expect((await fetch(url)).status).toBe(200)
      expect((await fetch(`${url}&path=..`)).status).toBe(400)
      const created = await post('threads', { projectPath: root, text: 'Explain @file:README.md' })
      expect(created.status).toBe(201)
      expect(messages[0]).toContain('# Sample project')
      const id = (await created.json()).data.id
      await post(`threads/${id}/messages`, { text: '@file:src%2Fhello%20world.ts' })
      expect(messages[1]).toContain('export const greeting')

      // What the user wrote is what is stored, titled and previewed; contents only reach the agent.
      const detail = (await (await fetch(`${server.url}/api/threads/${id}/events`)).json()).data
      expect(detail.meta.title).toBe('Explain @file:README.md')
      const stored = detail.events.filter((e: { event: { kind: string } }) => e.event.kind === 'user_text').map((e: { event: { text: string } }) => e.event.text)
      expect(stored).toEqual(['Explain @file:README.md', '@file:src%2Fhello%20world.ts'])
      const transcript = readFileSync(detail.transcriptPath, 'utf8')
      expect(transcript).toContain('Attached: src/hello world.ts')
      expect(transcript).not.toContain('# Sample project')
      expect(transcript).not.toContain('export const greeting')
      const summary = (await (await fetch(`${server.url}/api/threads`)).json()).data.find((t: { meta: { id: string } }) => t.meta.id === id)
      expect(summary.preview).toBe('@file:src%2Fhello%20world.ts')
    } finally { await server.close() }
  })
  it('refuses bad references with a plain 400 and leaves mid-word text alone', async () => {
    const root = fixture(); const messages: string[] = []
    const launcher: Launcher = (_request, emit) => ({ agent: 'codex', alive: () => true,
      send: (text) => { messages.push(text) }, respondApproval() {}, interrupt() {},
      close: async () => { emit({ kind: 'exit', code: 0 }) } })
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-files-state-')), webDist: root,
      launchers: { claude: launcher, codex: launcher } })
    try {
      const post = (path: string, body: unknown) => fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const refused = async (text: string) => {
        const res = await post('threads', { projectPath: root, text })
        const body = await res.json() as { error: string }
        expect(res.status).toBe(400)
        expect(body.error).not.toContain(root)
        expect(body.error).not.toMatch(/ENOENT|URI malformed/)
        return body.error
      }
      expect(await refused('Read @file:missing.md')).toBe('Not found in this project: missing.md')
      expect(await refused('Read @file:src%2Fnope%2Fa.ts')).toBe('Not found in this project: src/nope/a.ts')
      expect(await refused('Read @file:%E0%A4%A')).toMatch(/not a valid file reference/)
      expect(await refused('Run @workflow:not-saved')).toMatch(/Unknown workflow/)
      expect(messages).toEqual([])
      const plain = await post('threads', { projectPath: root, text: 'mail a@file:x and b@workflow:y as written' })
      expect(plain.status).toBe(201)
      expect(messages).toEqual(['mail a@file:x and b@workflow:y as written'])
      const listing = await fetch(`${server.url}/api/files/read?${new URLSearchParams({ projectPath: root, path: 'gone.txt' })}`)
      expect(listing.status).toBe(400)
      expect((await listing.json()).error).toBe('Not found in this project: gone.txt')
    } finally { await server.close() }
  })
  it('matches references only at the start of a token', () => {
    const root = fixture()
    expect(expandFiles('see(@file:README.md)', root)).toBe('see(@file:README.md)')
    expect(expandFiles('line one\n@file:README.md', root)).toContain('# Sample project')
    expect(() => expandFiles('@file:missing.md', root)).toThrow(MessageReferenceError)
    expect(describeAttachments('Check @file:src%2Fhello%20world.ts and @file:README.md please')).toEqual({
      text: 'Check and please', attachments: ['src/hello world.ts', 'README.md'] })
  })
  it('hands a switched agent the reference, not a copy of the file', () => {
    const handoff = buildHandoff([{ ts: '', event: { kind: 'user_text', text: 'Summarise @file:notes.md' } }], '/project')
    expect(handoff).toContain('USER: Summarise\nAttached: notes.md')
    expect(handoff).not.toContain('@file:')
  })
})
