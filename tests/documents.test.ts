import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentsDir, fileOnDisk, listDocuments, markDocument, renameFile } from '../server/files/documents.ts'
import { readProjectFile } from '../server/files/browser.ts'
import { writeProjectFile } from '../server/files/editor.ts'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-docs-'))
  const project = mkdtempSync(join(tmpdir(), 'cockpit-docs-project-'))
  return { root, project, dir: documentsDir(root, project) }
}

describe('your documents', () => {
  it('live in the app folder, one per project, never in the repository', () => {
    const { root, project, dir } = setup()
    expect(dir.startsWith(join(root, 'documents'))).toBe(true)
    expect(documentsDir(root, `${project}-other`)).not.toBe(dir)
    writeProjectFile(dir, 'plan.md', '# Plan\n', null)
    expect(readProjectFile(dir, 'plan.md').text).toBe('# Plan\n')
    expect(existsSync(join(project, 'plan.md'))).toBe(false)
  })

  it('list pinned first, hide nothing, and archive also unpins', () => {
    const { root, project, dir } = setup()
    for (const name of ['a.md', 'b.json', 'c.txt']) writeFileSync(join(dir, name), 'x')
    markDocument(root, project, 'c.txt', { pinned: true })
    expect(listDocuments(root, project)[0]).toMatchObject({ name: 'c.txt', pinned: true, archived: false })
    markDocument(root, project, 'c.txt', { archived: true })
    expect(listDocuments(root, project).find((d) => d.name === 'c.txt')).toMatchObject({ pinned: false, archived: true })
    markDocument(root, project, 'c.txt', { archived: false })
    expect(listDocuments(root, project).find((d) => d.name === 'c.txt')?.archived).toBe(false)
    expect(() => markDocument(root, project, 'missing.md', { pinned: true })).toThrow(/Not found/)
  })

  it('drop marks for files that are gone', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'gone.md'), 'x')
    markDocument(root, project, 'gone.md', { pinned: true })
    rmSync(join(dir, 'gone.md'))
    expect(listDocuments(root, project)).toEqual([])
    writeFileSync(join(dir, 'gone.md'), 'back')
    expect(listDocuments(root, project)[0]?.pinned).toBe(false)
  })
})

describe('renaming', () => {
  it('renames in place, keeps document marks, and never replaces a file', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'draft.md'), 'one')
    writeFileSync(join(dir, 'taken.md'), 'two')
    markDocument(root, project, 'draft.md', { pinned: true })
    expect(renameFile(root, project, 'documents', 'draft.md', 'final.md')).toBe('final.md')
    expect(listDocuments(root, project).find((d) => d.name === 'final.md')?.pinned).toBe(true)
    expect(() => renameFile(root, project, 'documents', 'final.md', 'taken.md')).toThrow(/already exists/)
    expect(readFileSync(join(dir, 'taken.md'), 'utf8')).toBe('two')
  })

  it('stays in the same folder of the project and refuses odd names', () => {
    const { root, project } = setup()
    mkdirSync(join(project, 'docs'))
    writeFileSync(join(project, 'docs', 'old.md'), 'x')
    expect(renameFile(root, project, 'project', 'docs/old.md', 'new.md')).toBe('docs/new.md')
    expect(existsSync(join(project, 'docs', 'new.md'))).toBe(true)
    for (const bad of ['../escape.md', 'sub/new.md', '.hidden', '', 'node_modules']) {
      expect(() => renameFile(root, project, 'project', 'docs/new.md', bad)).toThrow()
    }
    expect(() => renameFile(root, project, 'project', 'docs', 'folder2')).toThrow(/Only files/)
    expect(() => renameFile(root, project, 'project', '../outside.md', 'x.md')).toThrow()
  })

  it('locates files on disk only inside the space', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'n.md'), 'x')
    expect(fileOnDisk(root, project, 'documents', 'n.md').endsWith('/n.md')).toBe(true)
    expect(() => fileOnDisk(root, project, 'documents', '../x')).toThrow()
    expect(() => fileOnDisk(root, project, 'project', '')).toThrow()
  })
})

