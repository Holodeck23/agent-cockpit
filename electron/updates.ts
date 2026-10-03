// Check for Updates: reads the official GitHub release feed, picks the newest release this
// install may take, and validates that its download is the official Apple-silicon DMG.
// Nothing is installed here — the app only opens the validated DMG in the person's browser.
import semver from 'semver'
import { z } from 'zod'

export type UpdateChannel = 'stable' | 'prerelease'

// Every public Cockpit build so far is a GitHub prerelease, so testers must see prereleases.
// Switch to 'stable' when a stable line exists and this build belongs to it.
export const UPDATE_CHANNEL: UpdateChannel = 'prerelease'

const REPO_PATH = '/Holodeck23/agent-cockpit'
export const FEED_URL = `https://api.github.com/repos${REPO_PATH}/releases?per_page=30`
const DOWNLOAD_PATH = new RegExp(`^${REPO_PATH}/releases/download/([^/]+)/(Cockpit-[0-9A-Za-z.+-]+-arm64\\.dmg)$`)
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 2_000_000
const NOTES_MAX_CHARS = 1_200

export interface AvailableUpdate {
  readonly version: string
  readonly title: string
  readonly notes: string
  readonly assetName: string
  readonly size: number
  readonly downloadUrl: string
}

export type UpdateCheck =
  | { readonly state: 'available'; readonly current: string; readonly update: AvailableUpdate }
  | { readonly state: 'up-to-date'; readonly current: string; readonly latest: string | undefined }
  | { readonly state: 'no-compatible-download'; readonly current: string; readonly latest: string }
  | { readonly state: 'rate-limited'; readonly current: string; readonly resetAt: Date | undefined }
  | { readonly state: 'unavailable'; readonly current: string; readonly reason: string }

const assetSchema = z.object({
  name: z.string(),
  size: z.number(),
  state: z.string(),
  browser_download_url: z.string(),
})
const releaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullish(),
  assets: z.array(assetSchema),
})
const feedSchema = z.array(releaseSchema)
type Release = z.infer<typeof releaseSchema>
type Asset = z.infer<typeof assetSchema>

/** The tag and file name of an official release DMG URL, or undefined for anything else. */
function parseOfficialDownload(raw: string): { tag: string; name: string } | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  if (url.href !== raw || url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
  if (url.port || url.username || url.password || url.search || url.hash) return undefined
  const match = DOWNLOAD_PATH.exec(url.pathname)
  if (!match) return undefined
  try {
    return { tag: decodeURIComponent(match[1]!), name: match[2]! }
  } catch {
    return undefined
  }
}

export function isOfficialDownload(url: string): boolean {
  return parseOfficialDownload(url) !== undefined
}

function compatibleAsset(release: Release): Asset | undefined {
  return release.assets.find((asset) => {
    if (asset.state !== 'uploaded' || !(asset.size > 0)) return false
    const target = parseOfficialDownload(asset.browser_download_url)
    return target !== undefined && target.tag === release.tag_name && target.name === asset.name
  })
}

// Control and bidirectional-override characters can disguise text in a native dialog.
const stripHidden = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '')

/** Release notes are untrusted markdown: show them as short plain text. */
export function displayNotes(body: string | null | undefined, max: number = NOTES_MAX_CHARS): string {
  if (!body) return ''
  const text = stripHidden(body)
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lineEnd = cut.lastIndexOf('\n')
  return `${(lineEnd > max / 2 ? cut.slice(0, lineEnd) : cut).trimEnd()}…`
}

export type ReleaseNotes =
  | { readonly state: 'found'; readonly version: string; readonly title: string; readonly markdown: string }
  | { readonly state: 'missing'; readonly version: string }
  | { readonly state: 'unavailable'; readonly reason: string }

const FULL_NOTES_MAX_CHARS = 40_000

/** The published notes for one version, as (untrusted) Markdown for the in-app Release Notes. */
export function releaseNotesFrom(feed: unknown, version: string): ReleaseNotes {
  const parsed = feedSchema.safeParse(feed)
  if (!parsed.success) return { state: 'unavailable', reason: 'GitHub returned release information Cockpit could not read.' }
  const release = parsed.data.find((r) => !r.draft && r.tag_name.replace(/^v/, '') === version)
  if (!release) return { state: 'missing', version }
  return {
    state: 'found',
    version,
    title: release.name?.trim() || `Cockpit ${version}`,
    markdown: stripHidden(release.body ?? '').trim().slice(0, FULL_NOTES_MAX_CHARS),
  }
}

/** Pure decision over a release feed. A feed that cannot be read is never "up to date". */
export function selectUpdate(feed: unknown, current: string, channel: UpdateChannel): UpdateCheck {
  const installed = semver.valid(current)
  if (!installed) return { state: 'unavailable', current, reason: `Cockpit could not read its own version (${current}).` }
  const parsed = feedSchema.safeParse(feed)
  if (!parsed.success) return { state: 'unavailable', current, reason: 'GitHub returned release information Cockpit could not read.' }

  const eligible = parsed.data
    .flatMap((release) => {
      const version = semver.valid(release.tag_name.replace(/^v/, ''))
      if (release.draft || !version) return []
      if (channel === 'stable' && (release.prerelease || semver.prerelease(version))) return []
      return [{ release, version }]
    })
    .sort((a, b) => semver.rcompare(a.version, b.version))

  const newer = eligible.filter((candidate) => semver.gt(candidate.version, installed))
  if (newer.length === 0) return { state: 'up-to-date', current, latest: eligible[0]?.version }

  for (const { release, version } of newer) {
    const asset = compatibleAsset(release)
    if (!asset) continue
    return {
      state: 'available',
      current,
      update: {
        version,
        title: release.name?.trim() || `Cockpit ${version}`,
        notes: displayNotes(release.body),
        assetName: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
      },
    }
  }
  return { state: 'no-compatible-download', current, latest: newer[0]!.version }
}

type FeedResult =
  | { readonly kind: 'feed'; readonly data: unknown }
  | { readonly kind: 'rate-limited'; readonly resetAt: Date | undefined }
  | { readonly kind: 'unavailable'; readonly reason: string }

interface CheckerDeps {
  readonly fetch: typeof fetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

async function readBounded(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return undefined
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function resetTime(response: Response): Date | undefined {
  const seconds = Number(response.headers.get('x-ratelimit-reset') ?? Number.NaN)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
}

/**
 * Fetches the feed with a timeout, a size bound and an ETag: an unchanged feed answers 304,
 * which GitHub does not count against the anonymous rate limit. Overlapping checks share one request.
 */
export function createUpdateChecker(deps: CheckerDeps): {
  check(current: string, channel: UpdateChannel): Promise<UpdateCheck>
  notes(version: string): Promise<ReleaseNotes>
} {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  let cached: { readonly etag: string; readonly data: unknown } | undefined
  let inFlight: Promise<FeedResult> | undefined

  const fetchFeed = async (): Promise<FeedResult> => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Cockpit-update-check',
      }
      if (cached) headers['if-none-match'] = cached.etag
      const response = await deps.fetch(FEED_URL, { headers, signal: controller.signal, redirect: 'error' })
      if (response.status === 304) {
        return cached ? { kind: 'feed', data: cached.data } : { kind: 'unavailable', reason: 'GitHub returned an unexpected response.' }
      }
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
        return { kind: 'rate-limited', resetAt: resetTime(response) }
      }
      if (!response.ok) return { kind: 'unavailable', reason: `GitHub answered with HTTP ${response.status}.` }
      const text = await readBounded(response, maxBytes)
      if (text === undefined) return { kind: 'unavailable', reason: 'The release information was larger than expected.' }
      let data: unknown
      try { data = JSON.parse(text) } catch { return { kind: 'unavailable', reason: 'GitHub returned release information Cockpit could not read.' } }
      const etag = response.headers.get('etag')
      cached = etag ? { etag, data } : undefined
      return { kind: 'feed', data }
    } catch {
      return timedOut
        ? { kind: 'unavailable', reason: 'Checking for updates timed out.' }
        : { kind: 'unavailable', reason: 'Cockpit could not reach GitHub. Check your internet connection.' }
    } finally {
      clearTimeout(timer)
    }
  }

  const readFeed = (): Promise<FeedResult> => {
    inFlight ??= fetchFeed().finally(() => { inFlight = undefined })
    return inFlight
  }

  return {
    async check(current, channel) {
      const feed = await readFeed()
      if (feed.kind === 'rate-limited') return { state: 'rate-limited', current, resetAt: feed.resetAt }
      if (feed.kind === 'unavailable') return { state: 'unavailable', current, reason: feed.reason }
      return selectUpdate(feed.data, current, channel)
    },
    async notes(version) {
      const feed = await readFeed()
      if (feed.kind === 'rate-limited') return { state: 'unavailable', reason: 'GitHub is limiting requests from this network. Try again in a few minutes.' }
      if (feed.kind === 'unavailable') return { state: 'unavailable', reason: feed.reason.replace('Checking for updates', 'Loading the release notes') }
      return releaseNotesFrom(feed.data, version)
    },
  }
}
