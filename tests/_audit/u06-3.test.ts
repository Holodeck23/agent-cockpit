import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentsDir, listDocuments, markDocument, renameFile } from '../../server/files/documents.ts'

// u06-3: renaming 'notes.md' to 'Notes.md' (a capitalisation fix) must work. On a case-insensitive
// volume (default APFS) existsSync('Notes.md') is true because it is the same file, and renameFile
// refuses with "Notes.md already exists". A genuinely different file must still never be replaced.
describe('u06-3: case-only rename', () => {
  it('lets a document be renamed to the same name in different case, keeping its marks and content', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-u06-3-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-u06-3-project-'))
    const dir = documentsDir(root, project)
    writeFileSync(join(dir, 'notes.md'), 'my notes')
    markDocument(root, project, 'notes.md', { pinned: true })

    expect(renameFile(root, project, 'documents', 'notes.md', 'Notes.md')).toBe('Notes.md')

    expect(readdirSync(dir)).toContain('Notes.md')
    expect(readdirSync(dir)).not.toContain('notes.md')
    expect(readFileSync(join(dir, 'Notes.md'), 'utf8')).toBe('my notes')
    expect(listDocuments(root, project).find((d) => d.name === 'Notes.md')?.pinned).toBe(true)
  })

  it('works the same for a project file in a subfolder', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-u06-3-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-u06-3-project-'))
    writeFileSync(join(project, 'readme.md'), 'x')

    expect(renameFile(root, project, 'project', 'readme.md', 'README.md')).toBe('README.md')
    expect(readdirSync(project)).toContain('README.md')
  })
})
