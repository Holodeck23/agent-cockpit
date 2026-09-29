import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandFiles, listFiles, readProjectFile } from '../server/files/browser.ts'
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
      send: (text) => { messages.push(text); emit({ kind: 'user_text', text }) }, respondApproval() {}, interrupt() {},
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
    } finally { await server.close() }
  })
})
