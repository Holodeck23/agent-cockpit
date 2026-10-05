import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../server/git/changes.ts'
import { lineStillMatches, lineTarget, omittedText, stagingWord } from '../web/src/changes.ts'

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: 'src/new.ts', status: 'modified', base: 'head', head: 'a'.repeat(40), observedAt: '', binary: false, truncated: false, lines: [], ...over,
})

describe('Changes line targets (W7-03)', () => {
  it('a right-side line is the current file; a removed line is the base revision, by its old name', () => {
    const renamed = diff({ oldPath: 'src/old.ts', status: 'renamed' })
    expect(lineTarget(renamed, { kind: 'add', text: 'x', new: 7 })).toEqual({ kind: 'current', path: 'src/new.ts', line: 7, text: 'x' })
    expect(lineTarget(renamed, { kind: 'ctx', text: 'y', old: 3, new: 4 })).toEqual({ kind: 'current', path: 'src/new.ts', line: 4, text: 'y' })
    expect(lineTarget(renamed, { kind: 'del', text: 'z', old: 5 })).toEqual({ kind: 'historical', path: 'src/old.ts', line: 5 })
    expect(lineTarget(renamed, { kind: 'hunk', text: '@@' })).toBeUndefined()
  })
  it('a deleted file has no current lines', () => {
    expect(lineTarget(diff({ status: 'deleted' }), { kind: 'ctx', text: 'y', old: 3, new: 3 })).toBeUndefined()
  })
  it('opens only when the line still reads the same; otherwise the file changed since it was read', () => {
    expect(lineStillMatches('a\nb\nc\n', 2, 'b')).toBe(true)
    expect(lineStillMatches('a\r\nb\r\n', 2, 'b')).toBe(true)
    expect(lineStillMatches('a\nB\nc\n', 2, 'b')).toBe(false)
    expect(lineStillMatches('a\n', 9, 'b')).toBe(false)
  })
  it('says why no text diff is shown', () => {
    expect(omittedText(diff({ omitted: 'symlink', symlinkTarget: '/etc/hosts' }))).toMatch(/link to \/etc\/hosts.*not what it points to/)
    expect(omittedText(diff({ omitted: 'submodule', submodule: { from: 'a'.repeat(40), to: 'b'.repeat(40), modified: true, untracked: false } }))).toMatch(/aaaaaaaa → bbbbbbbb.*uncommitted changes/)
    expect(omittedText(diff())).toBeUndefined()
  })
  it('names staging plainly', () => {
    const f = { path: 'a', status: 'modified' as const }
    expect(stagingWord({ ...f, staged: true, unstaged: true })).toBe('Partly staged')
    expect(stagingWord({ ...f, staged: false, unstaged: true })).toBe('Not staged')
    expect(stagingWord({ ...f, status: 'untracked', staged: false, unstaged: true })).toBeUndefined()
  })
})
