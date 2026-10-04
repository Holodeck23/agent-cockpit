import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentsDir, documentsFolder, fileOnDisk, listDocuments, markDocument, renameFile, searchDocuments, setDocumentsFolder } from '../server/files/documents.ts'
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


describe('searching your documents', () => {
  it('finds current and archived documents by name or by a word inside, with the matching line', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'launch-plan.md'), '# Launch\n\nShip the beta on Friday.\n')
    writeFileSync(join(dir, 'old.md'), 'The Beta pricing we dropped.\n')
    writeFileSync(join(dir, 'other.txt'), 'nothing here\n')
    markDocument(root, project, 'old.md', { archived: true })
    const found = searchDocuments(root, project, 'beta')
    expect(found.map((d) => d.name).sort()).toEqual(['launch-plan.md', 'old.md'])
    expect(found.find((d) => d.name === 'old.md')).toMatchObject({ archived: true, excerpt: 'The Beta pricing we dropped.' })
    expect(found.find((d) => d.name === 'launch-plan.md')?.excerpt).toBe('Ship the beta on Friday.')
    expect(searchDocuments(root, project, 'launch').map((d) => d.name)).toEqual(['launch-plan.md'])
  })

  it('needs every word, skips binary files and returns nothing for an empty query', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'a.md'), 'alpha beta\n')
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 98, 101, 116, 97]))
    expect(searchDocuments(root, project, 'alpha beta').map((d) => d.name)).toEqual(['a.md'])
    expect(searchDocuments(root, project, 'alpha gamma')).toEqual([])
    expect(searchDocuments(root, project, 'beta').map((d) => d.name)).toEqual(['a.md'])
    expect(searchDocuments(root, project, '  ')).toEqual([])
  })
})

describe('a different documents folder per project (F14)', () => {
  it('copies the documents to the chosen folder, keeps the old ones, and reads from there afterwards', () => {
    const { root, project, dir } = setup()
    writeFileSync(join(dir, 'plan.md'), 'plan')
    markDocument(root, project, 'plan.md', { pinned: true })
    const chosen = mkdtempSync(join(tmpdir(), 'cockpit-docs-elsewhere-'))
    writeFileSync(join(chosen, 'plan.md'), 'already here')
    const moved = setDocumentsFolder(root, project, chosen)
    expect(moved).toEqual({ folder: chosen, copied: ['plan (copy).md'] })
    expect(readFileSync(join(chosen, 'plan.md'), 'utf8')).toBe('already here')
    expect(existsSync(join(dir, 'plan.md'))).toBe(true)
    expect(documentsDir(root, project)).toBe(chosen)
    expect(documentsFolder(root, project)).toEqual({ folder: chosen, custom: true })
    expect(listDocuments(root, project).map((d) => d.name).sort()).toEqual(['plan (copy).md', 'plan.md'])
  })

  it('refuses a folder inside the project or one that does not exist, and can go back to Cockpit\'s folder', () => {
    const { root, project, dir } = setup()
    mkdirSync(join(project, 'notes'))
    expect(() => setDocumentsFolder(root, project, join(project, 'notes'))).toThrow(/outside the project/)
    expect(() => setDocumentsFolder(root, project, join(project, 'missing'))).toThrow()
    expect(() => setDocumentsFolder(root, project, 'relative/path')).toThrow()
    const chosen = mkdtempSync(join(tmpdir(), 'cockpit-docs-elsewhere-'))
    setDocumentsFolder(root, project, chosen)
    setDocumentsFolder(root, project, null)
    expect(documentsDir(root, project)).toBe(dir)
    expect(documentsFolder(root, project).custom).toBe(false)
  })
})
