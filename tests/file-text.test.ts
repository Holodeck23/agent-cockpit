import { describe, expect, it } from 'vitest'
import { copyPath, forDisk, forEditor, isDirty, joinName, nextInFolder, lineEndingOf, newFilePath, openFile, splitName } from '../web/src/file-text.ts'

describe('line endings in the file editor', () => {
  it('detects LF, CRLF and mixed files', () => {
    expect(lineEndingOf('a\nb\n')).toBe('\n')
    expect(lineEndingOf('no newline')).toBe('\n')
    expect(lineEndingOf('a\r\nb\r\n')).toBe('\r\n')
    expect(lineEndingOf('a\r\nb\n')).toBeUndefined()
    expect(lineEndingOf('a\rb')).toBeUndefined()
  })

  it('round-trips a CRLF file unchanged when nothing was edited', () => {
    const text = '﻿line one\r\nline two\r\n'
    const file = openFile('a.txt', text, 'v1')
    expect(file.draft).toBe('﻿line one\nline two\n')
    expect(isDirty(file)).toBe(false)
    expect(forDisk(file.draft, file.eol!)).toBe(text)
    expect(forDisk(`${file.draft}three\n`, '\r\n')).toBe(`${text}three\r\n`)
    expect(forEditor('x\r\ny')).toBe('x\ny')
  })

  it('treats a restored draft as unsaved', () => {
    expect(isDirty(openFile('a.txt', 'disk\n', 'v1', 'draft\n'))).toBe(true)
  })
})

describe('new file names', () => {
  it('joins a plain visible name to the folder and refuses anything else', () => {
    expect(newFilePath('', 'notes.md')).toBe('notes.md')
    expect(newFilePath('src', ' notes.md ')).toBe('src/notes.md')
    for (const bad of ['', '  ', '.env', 'a/b.md', '..', 'a\\b']) expect(newFilePath('src', bad)).toBeUndefined()
  })
})

describe('copy names', () => {
  it('adds (copy) before the extension and numbers later ones', () => {
    expect(copyPath('README.md', 1)).toBe('README (copy).md')
    expect(copyPath('docs/plan.v2.md', 2)).toBe('docs/plan.v2 (copy 2).md')
    expect(copyPath('Makefile', 1)).toBe('Makefile (copy)')
    expect(copyPath('docs/.hidden', 1)).toBe('docs/.hidden (copy)')
  })
})

describe('renaming with a separate name and extension', () => {
  it('splits at the last dot, leaving names without one whole', () => {
    expect(splitName('notes.md')).toEqual({ stem: 'notes', ext: 'md' })
    expect(splitName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: 'gz' })
    expect(splitName('Makefile')).toEqual({ stem: 'Makefile', ext: '' })
    expect(splitName('trailing.')).toEqual({ stem: 'trailing.', ext: '' })
  })

  it('joins them back, with or without a typed dot, and trims both', () => {
    expect(joinName(' plan ', 'md')).toBe('plan.md')
    expect(joinName('plan', '.md')).toBe('plan.md')
    expect(joinName('plan', ' ')).toBe('plan')
    expect(joinName('plan', '..md')).toBe('plan.md')
  })
})

describe('after a file goes to the Trash', () => {
  it('selects the next file in the folder, or the one before at the end', () => {
    expect(nextInFolder(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextInFolder(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextInFolder(['a'], 'a')).toBeUndefined()
    expect(nextInFolder(['a', 'b'], 'zz')).toBeUndefined()
  })
})
