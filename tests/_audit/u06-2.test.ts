import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { documentsDir, setDocumentsFolder } from '../../server/files/documents.ts'

// u06-2: setDocumentsFolder's "outside the project" check is relative(project, folder).startsWith('..'),
// which also matches a child folder whose NAME begins with two dots ('<project>/..notes').
describe('u06-2: documents folder named with a leading ".." inside the project', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-u062-root-'))
    const project = mkdtempSync(join(tmpdir(), 'audit-u062-project-'))
    return { root, project }
  }

  it('refuses <project>/..notes like any other folder inside the project', () => {
    const { root, project } = setup()
    const inside = join(project, '..notes')
    mkdirSync(inside)
    expect(() => setDocumentsFolder(root, project, inside)).toThrow(/outside the project/)
    // and nothing was recorded: documents still live in Cockpit's own folder
    expect(documentsDir(root, project).startsWith(join(root, 'documents'))).toBe(true)
  })

  it('refuses a nested <project>/..drafts/sub as well', () => {
    const { root, project } = setup()
    const inside = join(project, '..drafts', 'sub')
    mkdirSync(inside, { recursive: true })
    expect(() => setDocumentsFolder(root, project, inside)).toThrow(/outside the project/)
  })

  it('control: a folder genuinely outside the project is still accepted', () => {
    const { root, project } = setup()
    const outside = mkdtempSync(join(tmpdir(), 'audit-u062-elsewhere-'))
    expect(setDocumentsFolder(root, project, outside).folder).toBe(outside)
    const pointer = readFileSync(join(root, 'documents', readdirPointer(root)), 'utf8').trim()
    expect(pointer).toBe(outside)
    expect(existsSync(outside)).toBe(true)
  })
})

import { readdirSync } from 'node:fs'
function readdirPointer(root: string): string {
  return readdirSync(join(root, 'documents')).find((n) => n.endsWith('.location')) as string
}
