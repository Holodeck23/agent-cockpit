import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../server/files/browser.ts'
import { FileConflictError, writeProjectFile } from '../server/files/editor.ts'
import { startServer } from '../server/start.ts'
import type { Launcher } from '../server/threads/manager.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-edit-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# Sample project\n')
  return root
}

describe('saving project files', () => {
  it('saves from the version it was opened at, keeps the mode, and leaves no temporary file', () => {
    const root = fixture(); chmodSync(join(root, 'README.md'), 0o600)
    const opened = readProjectFile(root, 'README.md')
    const saved = writeProjectFile(root, 'README.md', '# Edited\n', opened.version)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Edited\n')
    expect(saved.version).toBe(readProjectFile(root, 'README.md').version)
    expect(statSync(join(root, 'README.md')).mode & 0o777).toBe(0o600)
    expect(readdirSync(root).filter((name) => name.includes('cockpit-'))).toEqual([])
  })

  it('refuses to overwrite a change made on disk since the file was opened', () => {
    const root = fixture()
    const opened = readProjectFile(root, 'README.md')
    writeFileSync(join(root, 'README.md'), '# The agent wrote this\n')
    expect(() => writeProjectFile(root, 'README.md', '# Mine\n', opened.version)).toThrow(FileConflictError)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# The agent wrote this\n')
  })

  it('keeps a byte-order mark through a read and save', () => {
    const root = fixture(); writeFileSync(join(root, 'bom.txt'), '﻿hello')
    const opened = readProjectFile(root, 'bom.txt')
    expect(opened.text).toBe('﻿hello')
    writeProjectFile(root, 'bom.txt', opened.text, opened.version)
    expect(readFileSync(join(root, 'bom.txt'))[0]).toBe(0xef)
  })

  it('keeps the path rules: no traversal, symlinks, hidden folders, oversized or binary text', () => {
    const root = fixture(); const outside = fixture()
    symlinkSync(outside, join(root, 'outside'))
    symlinkSync(join(root, 'README.md'), join(root, 'alias.md'))
    mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'x.js'), 'x')
    const version = readProjectFile(root, 'README.md').version
    expect(() => writeProjectFile(root, '../README.md', 'x', version)).toThrow(/inside the project/)
    expect(() => writeProjectFile(root, 'outside/README.md', 'x', version)).toThrow(/inside the project/)
    expect(() => writeProjectFile(root, 'alias.md', 'x', version)).toThrow(/Symbolic links/)
    expect(() => writeProjectFile(root, 'node_modules/x.js', 'x', version)).toThrow(/excluded/)
    expect(() => writeProjectFile(root, 'README.md', 'x'.repeat(100_001), version)).toThrow(/100 KB/)
    expect(() => writeProjectFile(root, 'README.md', 'a\0b', version)).toThrow(/NUL/)
    expect(readFileSync(join(outside, 'README.md'), 'utf8')).toBe('# Sample project\n')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Sample project\n')
  })

  it('creates a new file only in an existing folder, never replacing one or making it hidden', () => {
    const root = fixture()
    expect(writeProjectFile(root, 'src/new.ts', 'export {}\n', null).path).toBe('src/new.ts')
    expect(readFileSync(join(root, 'src/new.ts'), 'utf8')).toBe('export {}\n')
    expect(() => writeProjectFile(root, 'README.md', 'x', null)).toThrow(/already exists/)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Sample project\n')
    expect(() => writeProjectFile(root, 'missing/new.ts', 'x', null)).toThrow(/Not found/)
    expect(() => writeProjectFile(root, '.env', 'x', null)).toThrow(/visible file name/)
    expect(() => writeProjectFile(root, '../escape.txt', 'x', null)).toThrow(/visible file name|inside the project/)
    expect(readdirSync(join(root, 'src')).filter((name) => name.includes('cockpit-'))).toEqual([])
  })
})

describe('saving over HTTP', () => {
  it('needs an opened project, answers a conflict with 409, and saves otherwise', async () => {
    const root = fixture()
    const launcher: Launcher = (_request, emit) => ({ agent: 'codex', alive: () => true, send() {}, respondApproval() {}, interrupt() {},
      close: async () => { emit({ kind: 'exit', code: 0 }) } })
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-edit-state-')), webDist: root,
      launchers: { claude: launcher, codex: launcher } })
    try {
      const put = (body: unknown) => fetch(`${server.url}/api/files/write`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const version = readProjectFile(root, 'README.md').version
      expect((await put({ projectPath: root, path: 'README.md', text: 'x', expected: version })).status).toBe(404)
      await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })
      expect((await put({ projectPath: root, path: 'README.md', text: 'x', expected: 'nope' })).status).toBe(400)
      expect((await put({ projectPath: root, path: 'README.md', text: 'x', expected: '0'.repeat(64) })).status).toBe(409)
      const saved = await put({ projectPath: root, path: 'README.md', text: '# Saved\n', expected: version })
      expect(saved.status).toBe(200)
      expect((await saved.json()).data.version).toBe(readProjectFile(root, 'README.md').version)
    } finally { await server.close() }
  })
})
