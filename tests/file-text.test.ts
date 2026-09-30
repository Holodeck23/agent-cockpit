import { describe, expect, it } from 'vitest'
import { forDisk, forEditor, isDirty, lineEndingOf, newFilePath, openFile } from '../web/src/file-text.ts'

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
