import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeAttachments, fileReferenceToken, labelTarget, parseFileReference, referenceLabel } from '../server/files/references.ts'
import { expandFiles } from '../server/files/browser.ts'
import { linesOfSelection } from '../web/src/file-text.ts'

describe('file references with a line range', () => {
  it('write and read back a whole file, one line or a range', () => {
    expect(fileReferenceToken({ path: 'src/my app.ts' })).toBe('@file:src%2Fmy%20app.ts')
    expect(fileReferenceToken({ path: 'src/a.ts', line: 3, endLine: 7 })).toBe('@file:src%2Fa.ts#L3-L7')
    expect(parseFileReference('src%2Fa.ts#L3-L7')).toEqual({ path: 'src/a.ts', line: 3, endLine: 7 })
    expect(parseFileReference('src%2Fa.ts#L4')).toEqual({ path: 'src/a.ts', line: 4 })
    expect(parseFileReference('a%23L3.ts')).toEqual({ path: 'a#L3.ts' })
    expect(parseFileReference('a.ts#L7-L3')).toBeUndefined()
    expect(parseFileReference('a.ts#L0')).toBeUndefined()
  })

  it('label a range as path:a-b, and turn the label back into a target', () => {
    expect(referenceLabel({ path: 'src/a.ts', line: 3, endLine: 7 })).toBe('src/a.ts:3-7')
    expect(referenceLabel({ path: 'src/a.ts', line: 3 })).toBe('src/a.ts:3')
    expect(labelTarget('src/a.ts:3-7')).toEqual({ path: 'src/a.ts', line: 3, endLine: 7 })
    expect(labelTarget('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(describeAttachments('Why? @file:src%2Fa.ts#L3-L7').attachments).toEqual(['src/a.ts:3-7'])
  })

  it('send the agent only those lines, saying which they are', () => {
    const project = mkdtempSync(join(tmpdir(), 'cockpit-ref-'))
    writeFileSync(join(project, 'a.ts'), 'one\ntwo\nthree\nfour\n')
    const text = expandFiles('Explain @file:a.ts#L2-L3', project)
    expect(text).toContain('Project file: a.ts (lines 2-3 of 4)')
    expect(text).toContain('<file-content>\ntwo\nthree\n</file-content>')
    expect(() => expandFiles('@file:a.ts#L9', project)).toThrow(/past the end/)
  })
})

describe('the lines a selection covers', () => {
  const text = 'one\ntwo\nthree\nfour'
  it('counts the lines touched, not a line the selection only reaches the start of', () => {
    expect(linesOfSelection(text, 4, 13)).toEqual({ line: 2, endLine: 3 })
    expect(linesOfSelection(text, 4, 8)).toEqual({ line: 2 })
    expect(linesOfSelection(text, 5, 6)).toEqual({ line: 2 })
    expect(linesOfSelection(text, 6, 6)).toBeUndefined()
  })
})

describe('peeking at selected lines', () => {
  it('shows only those lines, or the whole text without a range', async () => {
    const { linesOf } = await import('../web/src/file-text.ts')
    expect(linesOf('a\r\nb\r\nc\r\n', { line: 2, endLine: 3 })).toBe('b\nc')
    expect(linesOf('a\nb', { line: 1 })).toBe('a')
    expect(linesOf('a\nb', {})).toBe('a\nb')
  })
})
