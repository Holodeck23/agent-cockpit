import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyInto } from '../server/files/copy-in.ts'

const setup = () => {
  const project = mkdtempSync(join(tmpdir(), 'cockpit-copyin-project-'))
  const outside = mkdtempSync(join(tmpdir(), 'cockpit-copyin-src-'))
  mkdirSync(join(project, 'src'))
  return { project, outside }
}

describe('dropping files into the explorer (F8)', () => {
  it('copies files into the folder shown, never over an existing file', () => {
    const { project, outside } = setup()
    writeFileSync(join(outside, 'notes.md'), 'dropped')
    writeFileSync(join(outside, 'logo.svg'), '<svg/>')
    writeFileSync(join(project, 'src', 'notes.md'), 'mine')
    const result = copyInto(project, 'src', [join(outside, 'notes.md'), join(outside, 'logo.svg')])
    expect(result.copied).toEqual(['src/notes (copy).md', 'src/logo.svg'])
    expect(readFileSync(join(project, 'src', 'notes.md'), 'utf8')).toBe('mine')
    expect(readFileSync(join(project, 'src', 'notes (copy).md'), 'utf8')).toBe('dropped')
    expect(copyInto(project, 'src', [join(outside, 'notes.md')]).copied).toEqual(['src/notes (copy 2).md'])
  })

  it('skips folders, links and missing files with a reason, and never writes outside the project', () => {
    const { project, outside } = setup()
    mkdirSync(join(outside, 'folder'))
    writeFileSync(join(outside, 'real.txt'), 'x')
    symlinkSync(join(outside, 'real.txt'), join(outside, 'link.txt'))
    const result = copyInto(project, '', [join(outside, 'folder'), join(outside, 'link.txt'), join(outside, 'gone.txt'), 'relative.txt'])
    expect(result.copied).toEqual([])
    expect(result.skipped.map((s) => s.name)).toEqual(['folder', 'link.txt', 'gone.txt', 'relative.txt'])
    expect(() => copyInto(project, '../escape', [join(outside, 'real.txt')])).toThrow()
  })
})

describe('what the explorer says after a drop', () => {
  it('names one file, counts several, and says when a copy got its own name', async () => {
    const { dropNote } = await import('../web/src/drop-note.ts')
    expect(dropNote({ copied: ['src/logo.svg'], skipped: [] })).toBe('Copied logo.svg.')
    expect(dropNote({ copied: ['a.md', 'notes (copy).md'], skipped: [{ name: 'dir', reason: 'Folders are not copied; drop the files inside it' }] }))
      .toBe('Copied 2 files. A file with that name was already there, so the copy has its own name; nothing was replaced. dir: Folders are not copied; drop the files inside it.')
    expect(dropNote({ copied: [], skipped: [] })).toBe('Nothing was copied.')
  })
})
