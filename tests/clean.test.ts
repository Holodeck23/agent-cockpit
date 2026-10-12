import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyClean,
  clean,
  formatBytes,
  formatReport,
  gateFixturePaths,
  isRemovable,
  planClean,
  previousPublished,
  statEntry,
  type CleanRunOptions,
} from '../scripts/lib/clean.ts'
import { GATE_SUITES } from '../scripts/lib/gate-suites.ts'
import { createRunFolder } from '../scripts/lib/temp-run.ts'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)

let base: string
let repo: string
let temp: string
let outside: string

const put = (path: string, size = 2000): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(size))
  return path
}

/** Sets the modification time of a path and everything below it, links included. */
function setAge(path: string, hours: number): void {
  const when = new Date(NOW - hours * HOUR)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) lutimesSync(path, when, when)
  else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) setAge(join(path, name), hours)
    utimesSync(path, when, when)
  } else utimesSync(path, when, when)
}

const options = (extra: Partial<CleanRunOptions> = {}): CleanRunOptions => ({
  repoRoot: repo,
  tempDir: temp,
  currentVersion: '0.1.7',
  publishedVersions: ['0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7'],
  now: NOW,
  runningCommands: [],
  isAlive: () => false,
  ...extra,
})

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-clean-test-')))
  repo = join(base, 'repo')
  temp = join(base, 'tmp')
  outside = join(base, 'outside')
  for (const dir of [repo, temp, outside]) mkdirSync(dir)
  put(join(outside, 'precious.txt'))
  // release is a link to release.noindex, as a post-checkout hook makes it in every worktree.
  mkdirSync(join(repo, 'release.noindex'))
  symlinkSync('release.noindex', join(repo, 'release'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const releaseDir = (...parts: string[]): string => join(repo, 'release.noindex', ...parts)
const releaseNames = (): string[] => readdirSync(releaseDir()).sort()

describe('which version is the previous published one', () => {
  it('is the highest published version below the current one', () => {
    expect(previousPublished('0.1.7', ['0.1.5', '0.1.6', '0.1.7', '0.1.8'])).toBe('0.1.6')
    expect(previousPublished('0.1.7', ['0.1.4', '0.1.2'])).toBe('0.1.4')
  })

  it('compares numbers, not text', () => {
    expect(previousPublished('0.10.0', ['0.9.0', '0.2.0'])).toBe('0.9.0')
  })

  it('is unknown when nothing older was published or the current version is not a version', () => {
    expect(previousPublished('0.1.0', ['0.1.0'])).toBeUndefined()
    expect(previousPublished('0.1.7', [])).toBeUndefined()
    expect(previousPublished('next', ['0.1.6'])).toBeUndefined()
    expect(previousPublished('0.1.7', ['latest', '0.1', 'v0.1.6'])).toBeUndefined()
  })
})

describe('the gate fixtures', () => {
  it('include the packaged proof the cross-accounts suite launches', () => {
    expect(gateFixturePaths()).toContain('release/v0.1.5/proof')
  })

  it('follow the suites: a new needs path under release/ is protected without editing the cleaner', () => {
    const suite = { name: 'x', script: 'proof:x', covers: [], needs: ['release/v9.9.9/proof/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit', 'build/icon-1024.png'] }
    expect(gateFixturePaths([suite])).toEqual(['release/v9.9.9/proof'])
  })

  it('are derived from the real suite list', () => {
    for (const suite of GATE_SUITES) for (const need of suite.needs ?? []) {
      if (need.startsWith('release/')) expect(gateFixturePaths().some((fixture) => need.startsWith(`${fixture}/`)), need).toBe(true)
    }
  })
})

describe('release folders', () => {
  beforeEach(() => {
    for (const version of ['0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8']) {
      put(releaseDir(`v${version}`, `Cockpit-${version}-arm64.dmg`), 5000)
      put(releaseDir(`v${version}`, 'evidence', 'verify.log'))
    }
    put(releaseDir('v0.1.5', 'proof', 'mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'), 3000)
    put(releaseDir('mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'))
    put(releaseDir('parked', 'v0.1.1', 'Cockpit.dmg'))
    put(releaseDir('proof', 'mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'))
    put(releaseDir('builder-debug.yml'))
  })

  it('prunes versions older than the previous published one and nothing else', () => {
    const result = clean(options())
    expect(releaseNames()).toEqual(['builder-debug.yml', 'mac-arm64', 'parked', 'proof', 'v0.1.5', 'v0.1.6', 'v0.1.7', 'v0.1.8'])
    expect(result.removed.map((item) => item.path.replace(`${releaseDir()}/`, '')).sort()).toEqual(['v0.1.3', 'v0.1.4', 'v0.1.5/Cockpit-0.1.5-arm64.dmg', 'v0.1.5/evidence'])
  })

  it('keeps the previous published and the current version whole, and anything newer', () => {
    clean(options())
    for (const version of ['0.1.6', '0.1.7', '0.1.8']) {
      expect(existsSync(releaseDir(`v${version}`, `Cockpit-${version}-arm64.dmg`)), version).toBe(true)
      expect(existsSync(releaseDir(`v${version}`, 'evidence', 'verify.log')), version).toBe(true)
    }
  })

  it('never touches release/mac-arm64, release/parked or entries that are not version folders', () => {
    clean(options())
    expect(existsSync(releaseDir('mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'))).toBe(true)
    expect(existsSync(releaseDir('parked', 'v0.1.1', 'Cockpit.dmg'))).toBe(true)
    expect(existsSync(releaseDir('proof', 'mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'))).toBe(true)
    expect(existsSync(releaseDir('builder-debug.yml'))).toBe(true)
  })

  it('keeps the gate fixture release/v0.1.5/proof whole while pruning the rest of v0.1.5', () => {
    const result = clean(options())
    expect(existsSync(releaseDir('v0.1.5', 'proof', 'mac-arm64', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit'))).toBe(true)
    expect(existsSync(releaseDir('v0.1.5', 'evidence'))).toBe(false)
    expect(result.skipped.some((skip) => skip.path === releaseDir('v0.1.5', 'proof') && /fixture/.test(skip.why))).toBe(true)
  })

  it('counts from the package.json version, not from the newest folder on disk', () => {
    const result = clean(options({ currentVersion: '0.1.5', publishedVersions: ['0.1.3', '0.1.4', '0.1.5'] }))
    // previous published = 0.1.4: only v0.1.3 is older; v0.1.5 (current) and v0.1.8 (newer) stay whole.
    expect(result.removed.map((item) => item.path)).toEqual([releaseDir('v0.1.3')])
    expect(existsSync(releaseDir('v0.1.4', 'evidence', 'verify.log'))).toBe(true)
    expect(existsSync(releaseDir('v0.1.5', 'evidence', 'verify.log'))).toBe(true)
    expect(existsSync(releaseDir('v0.1.8', 'evidence', 'verify.log'))).toBe(true)
  })

  it('prunes nothing when no earlier published version is known, and says so', () => {
    const result = clean(options({ publishedVersions: [] }))
    expect(result.removed).toEqual([])
    expect(releaseNames()).toContain('v0.1.3')
    expect(result.skipped.some((skip) => /no published version/.test(skip.why))).toBe(true)
  })

  it('prunes nothing when the running processes could not be listed', () => {
    const result = clean(options({ runningCommands: null }))
    expect(result.removed).toEqual([])
    expect(releaseNames()).toContain('v0.1.3')
  })

  it('leaves a version alone while a running process was started from it', () => {
    const result = clean(options({ runningCommands: [`${releaseDir('v0.1.4', 'installed', 'Cockpit.app', 'Contents', 'MacOS')}/Cockpit --flag`] }))
    expect(existsSync(releaseDir('v0.1.4', 'evidence', 'verify.log'))).toBe(true)
    expect(existsSync(releaseDir('v0.1.3'))).toBe(false)
    expect(result.skipped.some((skip) => skip.path === releaseDir('v0.1.4') && /running process/.test(skip.why))).toBe(true)
  })

  it('does the same when the process names the package through the release link', () => {
    clean(options({ runningCommands: [`${join(repo, 'release', 'v0.1.4', 'installed', 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit')}`] }))
    expect(existsSync(releaseDir('v0.1.4', 'evidence', 'verify.log'))).toBe(true)
  })

  it('does not follow a link inside a pruned folder to what it points at', () => {
    symlinkSync(outside, releaseDir('v0.1.3', 'escape'))
    clean(options())
    expect(existsSync(releaseDir('v0.1.3'))).toBe(false)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
  })

  it('does not prune through a version folder that is itself a link', () => {
    rmSync(releaseDir('v0.1.3'), { recursive: true })
    symlinkSync(outside, releaseDir('v0.1.3'))
    const result = clean(options())
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(result.skipped.some((skip) => skip.path === releaseDir('v0.1.3') && /not a real folder/.test(skip.why))).toBe(true)
  })

  it('touches nothing if release/ resolves outside the repo', () => {
    put(join(outside, 'release-elsewhere', 'v0.1.3', 'Cockpit.dmg'))
    rmSync(join(repo, 'release'))
    symlinkSync(join(outside, 'release-elsewhere'), join(repo, 'release'))
    const result = clean(options())
    expect(existsSync(join(outside, 'release-elsewhere', 'v0.1.3', 'Cockpit.dmg'))).toBe(true)
    expect(result.removed).toEqual([])
    expect(result.skipped.some((skip) => /outside the repo/.test(skip.why))).toBe(true)
  })

  it('does nothing when there is no release folder', () => {
    rmSync(join(repo, 'release'))
    rmSync(releaseDir(), { recursive: true })
    expect(clean(options()).removed).toEqual([])
  })
})

describe('temp entries', () => {
  const entry = (name: string, hours: number, size = 2000): string => {
    const path = put(join(temp, name, 'data.bin'), size)
    setAge(join(temp, name), hours)
    return join(temp, name)
  }

  it('removes cockpit-* entries older than an hour, files and links included', () => {
    const old = entry('cockpit-old', 3)
    put(join(temp, 'cockpit-note.log'))
    setAge(join(temp, 'cockpit-note.log'), 5)
    symlinkSync(outside, join(temp, 'cockpit-link'))
    setAge(join(temp, 'cockpit-link'), 5)
    const result = clean(options())
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(temp, 'cockpit-note.log'))).toBe(false)
    expect(lstatSync(join(temp, 'cockpit-link'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(result.removed).toHaveLength(3)
  })

  it('keeps entries younger than an hour, and old ones that something inside wrote to recently', () => {
    const fresh = entry('cockpit-fresh', 0.5)
    const active = entry('cockpit-active', 6)
    utimesSync(join(active, 'data.bin'), new Date(NOW - 0.2 * HOUR), new Date(NOW - 0.2 * HOUR))
    const result = clean(options())
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(active)).toBe(true)
    expect(result.fresh).toBe(2)
    expect(result.removed).toEqual([])
  })

  it('leaves entries that do not start with cockpit-', () => {
    const other = entry('some-other-tool', 100)
    const near = entry('cockpitty', 100)
    clean(options())
    expect(existsSync(other)).toBe(true)
    expect(existsSync(near)).toBe(true)
  })

  it('sweeps a run folder whose owner is gone and keeps one whose owner still runs', () => {
    const dead = createRunFolder(temp, 111)
    const live = createRunFolder(temp, 222)
    setAge(dead, 4)
    setAge(live, 4)
    const result = clean(options({ isAlive: (pid) => pid === 222 }))
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(result.skipped.some((skip) => skip.path === live && /process 222/.test(skip.why))).toBe(true)
  })

  it('does not take a folder for a run folder because of its name alone', () => {
    const lookalike = entry('kAbC123', 50)
    clean(options())
    expect(existsSync(lookalike)).toBe(true)
  })

  it('keeps the temp dir of the process that runs the clean, even if it looks old', () => {
    const mine = entry('cockpit-mine', 9)
    mkdirSync(join(mine, 'inner'))
    const result = clean(options({ keep: [join(mine, 'inner')] }))
    expect(existsSync(mine)).toBe(true)
    expect(result.skipped.some((skip) => skip.path === mine)).toBe(true)
  })

  it('keeps an entry that is a mounted volume or contains one', () => {
    const volume = entry('cockpit-release-mount-AbC', 9)
    const nested = entry('cockpit-nested', 9)
    const real = statEntry
    const stat = (path: string) => {
      const found = real(path)
      if (path === volume) return { ...found, dev: found.dev + 1 }
      if (path === join(nested, 'data.bin')) return { ...found, dev: found.dev + 1 }
      return found
    }
    const result = clean(options({ stat }))
    expect(existsSync(volume)).toBe(true)
    expect(existsSync(nested)).toBe(true)
    expect(result.skipped.map((skip) => skip.why)).toEqual(expect.arrayContaining(['a mounted volume', 'contains a mounted volume']))
  })

  it('does nothing if the temp dir cannot be read', () => {
    const result = clean(options({ tempDir: join(base, 'missing') }))
    expect(result.removed).toEqual([])
    expect(result.skipped[0]?.why).toMatch(/cannot be read/)
  })
})

describe('dry run, byte counts and the report', () => {
  beforeEach(() => {
    put(releaseDir('v0.1.3', 'Cockpit-0.1.3-arm64.dmg'), 50_000)
    put(releaseDir('v0.1.6', 'Cockpit-0.1.6-arm64.dmg'), 50_000)
    put(join(temp, 'cockpit-a', 'data.bin'), 30_000)
    setAge(join(temp, 'cockpit-a'), 3)
  })

  it('lists exactly what a real run removes, and removes nothing', () => {
    const dry = clean(options({ dryRun: true }))
    expect(dry.dryRun).toBe(true)
    expect(dry.removed).toEqual([])
    expect(dry.freed).toBe(0)
    expect(existsSync(releaseDir('v0.1.3'))).toBe(true)
    expect(existsSync(join(temp, 'cockpit-a'))).toBe(true)
    const real = clean(options())
    expect(real.removed.map((item) => item.path).sort()).toEqual(dry.items.map((item) => item.path).sort())
  })

  it('counts the bytes it frees, at least the size of what was written', () => {
    const dry = clean(options({ dryRun: true }))
    expect(dry.bytes).toBeGreaterThanOrEqual(80_000)
    const real = clean(options())
    expect(real.freed).toBe(dry.bytes)
    expect(real.freed).toBeGreaterThanOrEqual(80_000)
    expect(real.freed).toBe(real.removed.reduce((sum, item) => sum + item.bytes, 0))
  })

  it('reports each removal and the total, worded for a dry run or a real one', () => {
    const shown = { repoRoot: repo, tempDir: temp }
    const dry = formatReport(clean(options({ dryRun: true })), shown)
    expect(dry.some((line) => line.startsWith('would remove') && line.includes('v0.1.3'))).toBe(true)
    expect(dry.at(-1)).toMatch(/^dry run: would remove 2 items, freeing .+ \(\d+ bytes\)\. Nothing was removed\.$/)
    const real = formatReport(clean(options()), shown)
    expect(real.some((line) => line.startsWith('removed') && line.includes('cockpit-a'))).toBe(true)
    expect(real.at(-1)).toMatch(/^removed 2 items, freed .+ \(\d+ bytes\)\.$/)
  })

  it('names the first temp entries and counts the rest', () => {
    for (let i = 0; i < 5; i += 1) {
      put(join(temp, `cockpit-extra-${i}`, 'data.bin'))
      setAge(join(temp, `cockpit-extra-${i}`), 3)
    }
    const lines = formatReport(clean(options({ dryRun: true })), { repoRoot: repo, tempDir: temp, limit: 2 })
    expect(lines.filter((line) => /^would remove {2}.*\/tmp\/cockpit-(a|extra-\d)/.test(line)).length).toBe(2)
    expect(lines.some((line) => /\.\.\. and 4 more cockpit-\* entries/.test(line))).toBe(true)
  })

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1500)).toBe('1.5 kB')
    expect(formatBytes(407_000_000)).toBe('407 MB')
    expect(formatBytes(11_000_000_000)).toBe('11.0 GB')
  })
})

describe('the guard on what may be removed', () => {
  it('accepts only paths strictly inside the repo or the temp dir', () => {
    expect(isRemovable(join(temp, 'cockpit-x'), repo, temp)).toBe(true)
    expect(isRemovable(releaseDir('v0.1.3'), repo, temp)).toBe(true)
    expect(isRemovable(join(repo, 'release', 'v0.1.3'), repo, temp)).toBe(true)
    expect(isRemovable(repo, repo, temp)).toBe(false)
    expect(isRemovable(temp, repo, temp)).toBe(false)
    expect(isRemovable(outside, repo, temp)).toBe(false)
    expect(isRemovable(join(outside, 'precious.txt'), repo, temp)).toBe(false)
    expect(isRemovable('/etc/hosts', repo, temp)).toBe(false)
  })

  it('refuses a path that leaves them through a link in its parent', () => {
    symlinkSync(outside, join(temp, 'cockpit-door'))
    expect(isRemovable(join(temp, 'cockpit-door', 'precious.txt'), repo, temp)).toBe(false)
    const plan = { items: [{ path: join(temp, 'cockpit-door', 'precious.txt'), bytes: 1, kind: 'temp' as const, why: 'test' }], skipped: [], fresh: 0, bytes: 1 }
    const result = applyClean(plan, { repoRoot: repo, tempDir: temp }, false)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(result.removed).toEqual([])
    expect(result.failed[0]?.message).toMatch(/refused/)
  })

  it('refuses a stale plan item that now points outside, and carries on with the rest', () => {
    put(join(temp, 'cockpit-ok', 'data.bin'))
    const plan = {
      items: [
        { path: join(outside, 'precious.txt'), bytes: 1, kind: 'temp' as const, why: 'test' },
        { path: join(temp, 'cockpit-ok'), bytes: 1, kind: 'temp' as const, why: 'test' },
      ],
      skipped: [],
      fresh: 0,
      bytes: 2,
    }
    const result = applyClean(plan, { repoRoot: repo, tempDir: temp }, false)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(existsSync(join(temp, 'cockpit-ok'))).toBe(false)
    expect(result.failed).toHaveLength(1)
    expect(result.removed).toHaveLength(1)
  })

  it('plans nothing it could not also remove', () => {
    put(releaseDir('v0.1.3', 'a.dmg'))
    put(join(temp, 'cockpit-old', 'd'))
    setAge(join(temp, 'cockpit-old'), 4)
    for (const item of planClean(options()).items) expect(isRemovable(item.path, repo, temp), item.path).toBe(true)
  })
})
