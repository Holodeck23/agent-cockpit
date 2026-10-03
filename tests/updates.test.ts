import { describe, expect, it } from 'vitest'
import { createUpdateChecker, displayNotes, isOfficialDownload, releaseNotesFrom, selectUpdate, type UpdateCheck } from '../electron/updates.ts'
import { updateDialog } from '../electron/update-dialog.ts'

const REPO = 'https://github.com/Holodeck23/agent-cockpit'

interface ReleaseOverrides {
  readonly draft?: boolean
  readonly prerelease?: boolean
  readonly body?: string | null
  readonly assets?: readonly unknown[]
}

function release(tag: string, overrides: ReleaseOverrides = {}): Record<string, unknown> {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    name: `Cockpit ${tag}`,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? true,
    body: overrides.body === undefined ? `Notes for ${tag}` : overrides.body,
    html_url: `${REPO}/releases/tag/${tag}`,
    assets: overrides.assets ?? [dmg(tag, `Cockpit-${version}-arm64.dmg`), sums(tag)],
  }
}

function dmg(tag: string, name: string, url = `${REPO}/releases/download/${tag}/${name}`): Record<string, unknown> {
  return { name, size: 133_450_176, state: 'uploaded', browser_download_url: url }
}

function sums(tag: string): Record<string, unknown> {
  return { name: 'SHA256SUMS', size: 90, state: 'uploaded', browser_download_url: `${REPO}/releases/download/${tag}/SHA256SUMS` }
}

const FEED = [release('v0.1.2'), release('v0.1.1'), release('v0.1.0')]

describe('selectUpdate', () => {
  it('offers the newest eligible release to an older install', () => {
    const result = selectUpdate(FEED, '0.1.1', 'prerelease')
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.update.version).toBe('0.1.2')
    expect(result.update.downloadUrl).toBe(`${REPO}/releases/download/v0.1.2/Cockpit-0.1.2-arm64.dmg`)
    expect(result.update.notes).toBe('Notes for v0.1.2')
  })

  it('reports up to date for the current and for a newer local build', () => {
    expect(selectUpdate(FEED, '0.1.2', 'prerelease')).toEqual({ state: 'up-to-date', current: '0.1.2', latest: '0.1.2' })
    expect(selectUpdate(FEED, '0.1.3-rc.1', 'prerelease')).toMatchObject({ state: 'up-to-date', current: '0.1.3-rc.1' })
  })

  it('orders prerelease tags by semantic version, not by feed order or string', () => {
    const feed = [release('v0.1.2-rc.1'), release('v0.1.10'), release('v0.1.9'), release('v0.1.2')]
    expect(selectUpdate(feed, '0.1.2-rc.1', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.1.10' } })
    expect(selectUpdate([release('v0.1.2')], '0.1.2-rc.1', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
    // An older release listed first must not win, and latest must be the highest version.
    expect(selectUpdate([release('v0.1.9'), release('v0.1.10')], '0.1.2', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.1.10' } })
    expect(selectUpdate([release('v0.1.1'), release('v0.1.2')], '0.1.2', 'prerelease')).toEqual({ state: 'up-to-date', current: '0.1.2', latest: '0.1.2' })
  })

  it('lets the prerelease channel see prereleases and keeps them from the stable channel', () => {
    const feed = [release('v0.2.0-rc.1', { prerelease: true }), release('v0.1.2', { prerelease: false })]
    expect(selectUpdate(feed, '0.1.1', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.2.0-rc.1' } })
    expect(selectUpdate(feed, '0.1.1', 'stable')).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
    // A semver prerelease is excluded from stable even if GitHub does not flag it.
    expect(selectUpdate([release('v0.2.0-rc.1', { prerelease: false })], '0.1.1', 'stable')).toMatchObject({ state: 'up-to-date' })
  })

  it('never offers a draft', () => {
    expect(selectUpdate([release('v0.2.0', { draft: true }), release('v0.1.1')], '0.1.1', 'prerelease')).toMatchObject({ state: 'up-to-date', latest: '0.1.1' })
  })

  it('skips releases whose tag is not a version', () => {
    expect(selectUpdate([release('nightly'), release('v0.1.2')], '0.1.1', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
  })

  it('falls back to the newest release that has an Apple-silicon DMG', () => {
    const feed = [release('v0.1.3', { assets: [dmg('v0.1.3', 'Cockpit-0.1.3-x64.dmg')] }), release('v0.1.2')]
    expect(selectUpdate(feed, '0.1.1', 'prerelease')).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
  })

  it('says a newer release has no compatible download instead of claiming up to date', () => {
    const noAssets = [release('v0.1.3', { assets: [sums('v0.1.3')] })]
    expect(selectUpdate(noAssets, '0.1.2', 'prerelease')).toEqual({ state: 'no-compatible-download', current: '0.1.2', latest: '0.1.3' })
    const wrongPlatform = [release('v0.1.3', { assets: [dmg('v0.1.3', 'Cockpit-0.1.3-x64.dmg'), dmg('v0.1.3', 'Cockpit-0.1.3-arm64.zip')] })]
    expect(selectUpdate(wrongPlatform, '0.1.2', 'prerelease')).toMatchObject({ state: 'no-compatible-download' })
    const empty = [release('v0.1.3', { assets: [{ ...dmg('v0.1.3', 'Cockpit-0.1.3-arm64.dmg'), size: 0 }] })]
    expect(selectUpdate(empty, '0.1.2', 'prerelease')).toMatchObject({ state: 'no-compatible-download' })
    const uploading = [release('v0.1.3', { assets: [{ ...dmg('v0.1.3', 'Cockpit-0.1.3-arm64.dmg'), state: 'starter' }] })]
    expect(selectUpdate(uploading, '0.1.2', 'prerelease')).toMatchObject({ state: 'no-compatible-download' })
  })

  it('rejects download URLs outside the official release path', () => {
    const name = 'Cockpit-0.1.3-arm64.dmg'
    const hostile = [
      `https://evil.example/Holodeck23/agent-cockpit/releases/download/v0.1.3/${name}`,
      `http://github.com/Holodeck23/agent-cockpit/releases/download/v0.1.3/${name}`,
      `https://github.com/someone/agent-cockpit/releases/download/v0.1.3/${name}`,
      `https://github.com/Holodeck23/agent-cockpit/releases/download/v0.1.0/${name}`,
      `https://user@github.com/Holodeck23/agent-cockpit/releases/download/v0.1.3/${name}`,
      `https://github.com:8443/Holodeck23/agent-cockpit/releases/download/v0.1.3/${name}`,
    ]
    for (const url of hostile) {
      expect(selectUpdate([release('v0.1.3', { assets: [dmg('v0.1.3', name, url)] })], '0.1.2', 'prerelease')).toMatchObject({ state: 'no-compatible-download' })
    }
  })

  it('treats malformed metadata as unavailable, never as up to date', () => {
    for (const feed of [null, {}, 'oops', [{ tag_name: 'v0.1.3' }], [{ ...release('v0.1.3'), assets: 'x' }]]) {
      const result = selectUpdate(feed, '0.1.2', 'prerelease')
      expect(result.state).toBe('unavailable')
    }
  })

  it('treats an unreadable installed version as unavailable', () => {
    expect(selectUpdate(FEED, 'not-a-version', 'prerelease').state).toBe('unavailable')
  })

  it('treats an empty feed as up to date with no known latest', () => {
    expect(selectUpdate([], '0.1.2', 'prerelease')).toEqual({ state: 'up-to-date', current: '0.1.2', latest: undefined })
  })
})

describe('isOfficialDownload', () => {
  it('accepts only the official arm64 DMG path for the given tag', () => {
    expect(isOfficialDownload(`${REPO}/releases/download/v0.1.2/Cockpit-0.1.2-arm64.dmg`)).toBe(true)
    expect(isOfficialDownload(`${REPO}/releases/download/v0.1.2/Cockpit-0.1.2-arm64.dmg?x=1`)).toBe(false)
    expect(isOfficialDownload(`${REPO}/releases/download/v0.1.2/../../../evil/Cockpit-0.1.2-arm64.dmg`)).toBe(false)
    expect(isOfficialDownload('javascript:alert(1)')).toBe(false)
    expect(isOfficialDownload('not a url')).toBe(false)
  })
})

describe('displayNotes', () => {
  it('turns markdown release notes into bounded plain text', () => {
    expect(displayNotes('## What changed\r\n\r\n- **Faster** start\u0007\n\n\n\n- Fix')).toBe('What changed\n\n- Faster start\n\n- Fix')
    const long = displayNotes(`${'line\n'.repeat(400)}`, 100)
    expect(long.length).toBeLessThanOrEqual(101)
    expect(long.endsWith('…')).toBe(true)
    expect(displayNotes(null)).toBe('')
  })
})

interface FakeResponse {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string
}

function fakeFetch(responses: FakeResponse[], seen: RequestInit[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {})
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return new Response(next.status === 304 ? null : next.body ?? '', { status: next.status, headers: next.headers })
  }) as typeof fetch
}

describe('createUpdateChecker', () => {
  it('fetches the official feed and selects an update', async () => {
    const seen: RequestInit[] = []
    const checker = createUpdateChecker({ fetch: fakeFetch([{ status: 200, body: JSON.stringify(FEED) }], seen) })
    const result = await checker.check('0.1.1', 'prerelease')
    expect(result).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
    expect(new Headers(seen[0]?.headers).get('accept')).toContain('application/vnd.github')
  })

  it('reuses the cached feed on 304 Not Modified', async () => {
    const seen: RequestInit[] = []
    const checker = createUpdateChecker({ fetch: fakeFetch([
      { status: 200, headers: { etag: '"abc"' }, body: JSON.stringify(FEED) },
      { status: 304 },
    ], seen) })
    await checker.check('0.1.2', 'prerelease')
    const second = await checker.check('0.1.1', 'prerelease')
    expect(new Headers(seen[1]?.headers).get('if-none-match')).toBe('"abc"')
    expect(second).toMatchObject({ state: 'available', update: { version: '0.1.2' } })
  })

  it('reports rate limiting with its reset time', async () => {
    const checker = createUpdateChecker({ fetch: fakeFetch([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791040000' } }]) })
    expect(await checker.check('0.1.2', 'prerelease')).toEqual({ state: 'rate-limited', current: '0.1.2', resetAt: new Date(1791040000 * 1000) })
    const tooMany = createUpdateChecker({ fetch: fakeFetch([{ status: 429 }]) })
    expect(await tooMany.check('0.1.2', 'prerelease')).toMatchObject({ state: 'rate-limited', resetAt: undefined })
  })

  it('reports offline, server errors, bad JSON and oversized responses as unavailable', async () => {
    const offline = createUpdateChecker({ fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
    const failures: UpdateCheck[] = [
      await offline.check('0.1.2', 'prerelease'),
      await createUpdateChecker({ fetch: fakeFetch([{ status: 500 }]) }).check('0.1.2', 'prerelease'),
      await createUpdateChecker({ fetch: fakeFetch([{ status: 403 }]) }).check('0.1.2', 'prerelease'),
      await createUpdateChecker({ fetch: fakeFetch([{ status: 200, body: '{not json' }]) }).check('0.1.2', 'prerelease'),
      await createUpdateChecker({ fetch: fakeFetch([{ status: 200, body: 'x'.repeat(64) }]), maxBytes: 32 }).check('0.1.2', 'prerelease'),
      await createUpdateChecker({ fetch: fakeFetch([{ status: 304 }]) }).check('0.1.2', 'prerelease'),
    ]
    for (const result of failures) expect(result.state).toBe('unavailable')
  })

  it('stops reading a streamed response that exceeds the size bound', async () => {
    const stream = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i += 1) controller.enqueue(new TextEncoder().encode('x'.repeat(16)))
        controller.close()
      },
    }), { status: 200 })) as typeof fetch
    const result = await createUpdateChecker({ fetch: stream, maxBytes: 32 }).check('0.1.2', 'prerelease')
    expect(result).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/larger than expected/) })
  })

  it('times out a stalled request', async () => {
    const stalled = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as typeof fetch
    const result = await createUpdateChecker({ fetch: stalled, timeoutMs: 20 }).check('0.1.2', 'prerelease')
    expect(result).toMatchObject({ state: 'unavailable' })
    if (result.state === 'unavailable') expect(result.reason).toMatch(/timed out/i)
  })

  it('shares one in-flight request between overlapping checks', async () => {
    let calls = 0
    const slow = (async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(JSON.stringify(FEED), { status: 200 })
    }) as typeof fetch
    const checker = createUpdateChecker({ fetch: slow })
    const [a, b] = await Promise.all([checker.check('0.1.1', 'prerelease'), checker.check('0.1.1', 'prerelease')])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })
})

describe('updateDialog', () => {
  it('offers Download Update with manual replacement guidance', () => {
    const result = selectUpdate(FEED, '0.1.1', 'prerelease')
    const dialog = updateDialog(result)
    expect(dialog.buttons).toEqual(['Download Update', 'Later'])
    expect(dialog.message).toContain('0.1.2')
    expect(dialog.detail).toContain('You have 0.1.1')
    expect(dialog.detail).toContain('Notes for v0.1.2')
    expect(dialog.detail).toMatch(/quit Cockpit/i)
    expect(dialog.detail).toMatch(/conversations and settings/i)
    expect(dialog.downloadUrl).toBe(`${REPO}/releases/download/v0.1.2/Cockpit-0.1.2-arm64.dmg`)
  })

  it('never words a failed check as up to date', () => {
    for (const result of [
      { state: 'unavailable', current: '0.1.2', reason: 'Could not reach GitHub.' },
      { state: 'rate-limited', current: '0.1.2', resetAt: undefined },
      { state: 'no-compatible-download', current: '0.1.2', latest: '0.1.3' },
    ] as const) {
      const dialog = updateDialog(result)
      expect(`${dialog.message} ${dialog.detail}`).not.toMatch(/you're up to date/i)
      expect(dialog.downloadUrl).toBeUndefined()
      expect(dialog.buttons).toEqual(['OK'])
    }
    expect(updateDialog({ state: 'unavailable', current: '0.1.2', reason: 'x' }).detail).toMatch(/does not mean/i)
  })

  it('confirms up to date with the installed version', () => {
    const dialog = updateDialog({ state: 'up-to-date', current: '0.1.2', latest: '0.1.2' })
    expect(dialog.message).toBe("You're up to date")
    expect(dialog.detail).toContain('0.1.2')
  })
})

describe('release notes for the running version', () => {
  it('finds this version in the feed and keeps the Markdown, minus hidden characters', () => {
    const feed = [release('v0.1.5', { body: '# Cockpit v0.1.5\n\n- **Faster**‮ list' }), release('v0.1.4')]
    expect(releaseNotesFrom(feed, '0.1.5')).toEqual({ state: 'found', version: '0.1.5', title: 'Cockpit v0.1.5', markdown: '# Cockpit v0.1.5\n\n- **Faster** list' })
  })
  it('says so when the version has no published notes, or the feed cannot be read', () => {
    expect(releaseNotesFrom([release('v0.1.4')], '0.1.5')).toEqual({ state: 'missing', version: '0.1.5' })
    expect(releaseNotesFrom([release('v0.1.5', { draft: true })], '0.1.5')).toEqual({ state: 'missing', version: '0.1.5' })
    expect(releaseNotesFrom({ nope: true }, '0.1.5')).toMatchObject({ state: 'unavailable' })
  })
  it('is read through the same cached feed as the update check', async () => {
    const checker = createUpdateChecker({ fetch: fakeFetch([{ status: 200, body: JSON.stringify(FEED) }]) })
    expect(await checker.notes('0.1.1')).toMatchObject({ state: 'found', markdown: 'Notes for v0.1.1' })
    expect(await createUpdateChecker({ fetch: fakeFetch([{ status: 500 }]) }).notes('0.1.1')).toMatchObject({ state: 'unavailable' })
  })
})
