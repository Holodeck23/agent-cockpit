import { describe, expect, it } from 'vitest'
import { CHAT_MIN_WIDTH, DEFAULT_PANE_WIDTH, MIN_PANE_WIDTH, openPage, paneWidth, parseLayouts, pendingOpen, requestOpen, updatePage } from '../web/src/browser-layout.ts'
import { addressToUrl, originLabel } from '../server/browser/address.ts'

describe('browser pane layout per page (W9.1)', () => {
  it('opens a page with defaults, and reopening keeps its width and mode', () => {
    let layouts = openPage({}, 'thread:a', 'http://localhost:3000/')
    expect(layouts['thread:a']).toEqual({ url: 'http://localhost:3000/', mode: 'desktop', width: DEFAULT_PANE_WIDTH, expanded: false, visible: true })
    layouts = updatePage(layouts, 'thread:a', { mode: 'mobile', width: 700, visible: false })
    layouts = openPage(layouts, 'thread:a', 'https://example.com/')
    expect(layouts['thread:a']).toEqual({ url: 'https://example.com/', mode: 'mobile', width: 700, expanded: false, visible: true })
  })
  it('keeps pages independent', () => {
    const layouts = openPage(openPage({}, 'thread:a', 'http://localhost:3000/'), 'thread:b', 'https://example.com/')
    expect(updatePage(layouts, 'thread:a', { visible: false })['thread:b']!.visible).toBe(true)
  })
  it('only remembers a safe address and a sane width', () => {
    const layouts = openPage({}, 'thread:a', 'http://localhost:3000/')
    expect(updatePage(layouts, 'thread:a', { url: 'about:blank' })['thread:a']!.url).toBe('http://localhost:3000/')
    expect(updatePage(layouts, 'thread:a', { url: 'chrome-error://chromewebdata/' })['thread:a']!.url).toBe('http://localhost:3000/')
    expect(updatePage(layouts, 'thread:a', { width: 10 })['thread:a']!.width).toBe(MIN_PANE_WIDTH)
    expect(updatePage(layouts, 'thread:missing', { visible: false })).toBe(layouts)
  })
  it('drops stored records that are malformed', () => {
    const raw = JSON.stringify({
      'thread:a': { url: 'https://example.com/', mode: 'desktop', width: 600, expanded: true, visible: true },
      'thread:b': { url: 'javascript:alert(1)', mode: 'desktop', width: 600 },
      'thread:c': { url: 'https://example.com/', mode: 'tablet', width: 600 },
      'thread:d': null,
    })
    expect(Object.keys(parseLayouts(raw))).toEqual(['thread:a'])
    expect(parseLayouts('{not json')).toEqual({})
    expect(parseLayouts('[1,2]')).toEqual({})
  })
  it('expanded takes all but the conversation minimum; restore returns the prior width', () => {
    const layouts = openPage({}, 'thread:a', 'http://localhost:3000/')
    const expanded = updatePage(layouts, 'thread:a', { expanded: true })['thread:a']!
    expect(paneWidth(expanded, 1300)).toBe(1300 - CHAT_MIN_WIDTH)
    expect(paneWidth(updatePage(layouts, 'thread:a', { expanded: false })['thread:a']!, 1300)).toBe(DEFAULT_PANE_WIDTH)
    // A narrow window caps the pane so the conversation keeps its minimum.
    expect(paneWidth(updatePage(layouts, 'thread:a', { width: 900 })['thread:a']!, 980)).toBe(980 - CHAT_MIN_WIDTH)
    // 980 px window less a 260 px list: both minimums do not fit, so the chat keeps 380 and the pane 340.
    expect(paneWidth(layouts['thread:a']!, 720)).toBe(340)
    expect(paneWidth(updatePage(layouts, 'thread:a', { expanded: true })['thread:a']!, 720)).toBe(340)
  })
})

// Processes → Open site on a conversation whose page is not on screen: the pane for that page mounts
// afterwards, and must still load what was asked for instead of showing the page as it was (W7.3).
describe('open requests survive the pane mounting later', () => {
  it('counts requests per page, so another page\'s request is not this page\'s', () => {
    const once = requestOpen({}, 'thread-a')
    expect(requestOpen(once, 'thread-a')).toEqual({ 'thread-a': 2 })
    expect(requestOpen(once, 'thread-b')).toEqual({ 'thread-a': 1, 'thread-b': 1 })
    expect(once).toEqual({ 'thread-a': 1 })
  })

  it('a request the page has not carried out is pending, whenever its pane mounts', () => {
    expect(pendingOpen(1, undefined)).toBe(true)
    expect(pendingOpen(1, 1)).toBe(false)
    expect(pendingOpen(2, 1)).toBe(true)
    expect(pendingOpen(0, undefined)).toBe(false)
  })
})

describe('address bar helpers', () => {
  it('labels local pages as Local and remote ones by host', () => {
    expect(originLabel('http://127.0.0.1:5173/')).toBe('Local')
    expect(originLabel('https://docs.example.com/x')).toBe('docs.example.com')
    expect(originLabel('nope')).toBe('')
  })
  it('is the same parser the host uses', () => {
    expect(addressToUrl('localhost:3000')).toBe('http://localhost:3000/')
  })
})
