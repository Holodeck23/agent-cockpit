import { describe, expect, it } from 'vitest'
import { HELP, issueUrl, looksLikeConnectionError } from '../server/help-links.ts'
import { notesBlocks } from '../web/src/notes-text.ts'

describe('Help links', () => {
  it('point at the public guide', () => {
    expect(HELP.troubleshooting).toBe('https://github.com/Holodeck23/agent-cockpit/blob/main/docs/user/troubleshooting.md')
    expect(HELP.network).toBe(`${HELP.troubleshooting}#network-problems`)
  })
  it('opens a new GitHub issue with the version and Mac filled in, and nothing private', () => {
    const url = new URL(issueUrl({ version: '0.1.5', macos: '26.0', arch: 'arm64' }))
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/Holodeck23/agent-cockpit/issues/new')
    const body = url.searchParams.get('body') ?? ''
    expect(body).toContain('Cockpit 0.1.5')
    expect(body).toContain('macOS 26.0 (arm64)')
    expect(body).not.toMatch(/\/Users\//)
  })
})

describe('spotting a connection problem', () => {
  it('matches network failures, not ordinary errors', () => {
    for (const text of ['connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND api.anthropic.com', 'TypeError: Failed to fetch', 'fetch failed', 'Request timed out (ETIMEDOUT)', 'API Error: Connection error.', 'Cockpit could not reach GitHub.']) {
      expect(looksLikeConnectionError(text), text).toBe(true)
    }
    for (const text of ['Unknown project', 'Rate limit reached', 'File not found: a.ts']) expect(looksLikeConnectionError(text), text).toBe(false)
  })
})

describe('release notes as blocks', () => {
  it('reads headings, bullets and paragraphs, with bold and code inline', () => {
    expect(notesBlocks('# Title\n\nIntro **bold** and `code`.\n\n## What changed\n- one\n* two\n\nLast line\njoined')).toEqual([
      { kind: 'heading', level: 1, text: [{ text: 'Title' }] },
      { kind: 'paragraph', text: [{ text: 'Intro ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'code', code: true }, { text: '.' }] },
      { kind: 'heading', level: 2, text: [{ text: 'What changed' }] },
      { kind: 'list', items: [[{ text: 'one' }], [{ text: 'two' }]] },
      { kind: 'paragraph', text: [{ text: 'Last line joined' }] },
    ])
  })
  it('shows links as their words only', () => {
    expect(notesBlocks('See [the guide](https://example.com) now')).toEqual([{ kind: 'paragraph', text: [{ text: 'See the guide now' }] }])
  })
})
