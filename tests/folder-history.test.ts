import { describe, expect, it } from 'vitest'
import { back, canGoBack, canGoForward, currentFolder, forward, parentOf, startHistory, visit } from '../web/src/folder-history.ts'

describe('Files folder history', () => {
  it('goes back and forward through visited folders', () => {
    let h = visit(visit(startHistory(), 'src'), 'src/components')
    expect(currentFolder(h)).toBe('src/components')
    h = back(h)
    expect(currentFolder(h)).toBe('src')
    expect(canGoForward(h)).toBe(true)
    h = forward(h)
    expect(currentFolder(h)).toBe('src/components')
    expect(canGoForward(h)).toBe(false)
  })

  it('drops the forward trail when you go somewhere new, and ignores a visit to the same folder', () => {
    let h = back(visit(visit(startHistory(), 'a'), 'a/b'))
    h = visit(h, 'docs')
    expect(h.stack).toEqual(['', 'a', 'docs'])
    expect(canGoForward(h)).toBe(false)
    expect(visit(h, 'docs')).toBe(h)
  })

  it('stays put at either end and knows each folder\'s parent', () => {
    const h = startHistory()
    expect(canGoBack(h)).toBe(false)
    expect(back(h)).toBe(h)
    expect(forward(h)).toBe(h)
    expect(parentOf('a/b/c')).toBe('a/b')
    expect(parentOf('a')).toBe('')
  })
})
