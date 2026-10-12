// What `npm run clean` removes, as plan-then-apply so --dry-run lists exactly what a real run does.
//
//   Temp dir   cockpit-* entries untouched for over an hour, and run folders (scripts/lib/temp-run.ts)
//              whose owner is gone. Anything newer, or whose owner process still runs, stays.
//   release/   version folders (v<x.y.z>) older than the previous published version.
//
// Never touched, whatever the age: release/mac-arm64 (may be the running app), the current
// package.json version, anything under release/parked, a gate fixture another suite needs
// (derived from scripts/lib/gate-suites.ts, today release/v0.1.5/proof), a package a running
// process was started from, and anything whose real path is outside the repo and the temp dir.
// Entries are never followed through symlinks.
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { GATE_SUITES, type GateSuite } from './gate-suites.ts'
import { isNewerVersion, parseVersion } from './release.ts'
import { isProcessAlive, RUN_FOLDER_NAME, runFolderOwner } from './temp-run.ts'

export const TEMP_PREFIX = 'cockpit-'
export const MAX_AGE_MS = 60 * 60 * 1000
const VERSION_DIR = /^v(\d+\.\d+\.\d+)$/
/** Entries directly under release/ that no rule here may remove. */
const NEVER_UNDER_RELEASE: readonly string[] = ['mac-arm64', 'parked']

/** What the planner needs to know about one filesystem entry. */
export interface Entry {
  readonly dev: number
  readonly mtimeMs: number
  readonly bytes: number
  readonly directory: boolean
}

export function statEntry(path: string): Entry {
  const stat = lstatSync(path)
  return { dev: stat.dev, mtimeMs: stat.mtimeMs, bytes: Math.max(stat.size, stat.blocks * 512), directory: stat.isDirectory() }
}

export interface CleanOptions {
  readonly repoRoot: string
  readonly tempDir: string
  /** package.json version: its release folder is never pruned. */
  readonly currentVersion: string
  /** Versions that were published (git tags v<x.y.z>). None known means no release folder is pruned. */
  readonly publishedVersions: readonly string[]
  readonly now?: number
  readonly maxAgeMs?: number
  /** Paths that must survive, e.g. the TMPDIR of the process that runs the clean. */
  readonly keep?: readonly string[]
  /** Command lines of running processes; a package one was started from is left alone. null = could not be read, so release folders are left alone. */
  readonly runningCommands?: readonly string[] | null
  readonly isAlive?: (pid: number) => boolean
  /** Test seam; lstat by default. */
  readonly stat?: (path: string) => Entry
}

export interface CleanItem {
  readonly path: string
  readonly bytes: number
  readonly kind: 'temp' | 'release'
  readonly why: string
}
export interface CleanSkip {
  readonly path: string
  readonly why: string
}
export interface CleanPlan {
  readonly items: readonly CleanItem[]
  /** Entries a rule looked at and spared for a reason worth showing. */
  readonly skipped: readonly CleanSkip[]
  /** cockpit-* entries younger than the age limit, counted not listed. */
  readonly fresh: number
  readonly bytes: number
}
export interface CleanResult extends CleanPlan {
  readonly dryRun: boolean
  readonly removed: readonly CleanItem[]
  readonly failed: readonly { readonly path: string; readonly message: string }[]
  /** Bytes of what was actually removed; 0 in a dry run. */
  readonly freed: number
}

const inside = (child: string, root: string): boolean => child.startsWith(root + sep)
const realOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Real location of an entry's parent plus its own name: the entry itself is never followed. */
function resolvedEntry(path: string): string | undefined {
  const parent = realOrUndefined(dirname(path))
  return parent ? join(parent, basename(path)) : undefined
}

function allowedRoots(repoRoot: string, tempDir: string): string[] {
  return [repoRoot, tempDir].map(realOrUndefined).filter((root): root is string => root !== undefined)
}

/** True only for a path strictly below the real repo or the real temp dir. */
export function isRemovable(path: string, repoRoot: string, tempDir: string): boolean {
  const resolved = resolvedEntry(path)
  return resolved !== undefined && allowedRoots(repoRoot, tempDir).some((root) => inside(resolved, root))
}

/** The release/<version>/<dir> folders a gate suite needs from an earlier package (its `needs`). */
export function gateFixturePaths(suites: readonly GateSuite[] = GATE_SUITES): string[] {
  const paths = new Set<string>()
  for (const suite of suites) {
    for (const need of suite.needs ?? []) {
      const parts = need.split('/')
      if (parts[0] === 'release' && parts.length >= 3) paths.add(parts.slice(0, 3).join('/'))
    }
  }
  return [...paths]
}

/** The highest published version below `current`: the one a rollback would go to. */
export function previousPublished(current: string, published: readonly string[]): string | undefined {
  if (!parseVersion(current)) return undefined
  return published
    .filter((version) => parseVersion(version) && isNewerVersion(current, version))
    .reduce<string | undefined>((best, version) => (best === undefined || isNewerVersion(version, best) ? version : best), undefined)
}

interface Measured {
  readonly bytes: number
  readonly newestMs: number
  readonly problem?: string
}

/** Size and newest modification time of a tree, without following links. */
function measure(root: string, rootDev: number, stat: (path: string) => Entry): Measured {
  let bytes = 0
  let newestMs = 0
  const pending = [root]
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    let entry: Entry
    try {
      entry = stat(path)
    } catch {
      continue // gone while we looked
    }
    if (entry.dev !== rootDev) return { bytes, newestMs, problem: 'contains a mounted volume' }
    bytes += entry.bytes
    newestMs = Math.max(newestMs, entry.mtimeMs)
    if (!entry.directory) continue
    try {
      for (const name of readdirSync(path)) pending.push(join(path, name))
    } catch {
      return { bytes, newestMs, problem: 'cannot be read' }
    }
  }
  return { bytes, newestMs }
}

const hours = (ms: number): string => `${Math.max(1, Math.floor(ms / 3_600_000))} h`

function planTemp(o: CleanOptions, stat: (path: string) => Entry): { items: CleanItem[]; skipped: CleanSkip[]; fresh: number } {
  const items: CleanItem[] = []
  const skipped: CleanSkip[] = []
  let fresh = 0
  const now = o.now ?? Date.now()
  const maxAge = o.maxAgeMs ?? MAX_AGE_MS
  const alive = o.isAlive ?? isProcessAlive
  const kept = (o.keep ?? []).flatMap((path) => [path, realOrUndefined(path)]).filter((p): p is string => p !== undefined)
  let names: string[]
  let root: Entry
  try {
    names = readdirSync(o.tempDir)
    root = stat(o.tempDir)
  } catch (error) {
    return { items, skipped: [{ path: o.tempDir, why: `cannot be read (${(error as Error).message})` }], fresh }
  }
  for (const name of names) {
    const named = name.startsWith(TEMP_PREFIX)
    const runNamed = RUN_FOLDER_NAME.test(name)
    if (!named && !runNamed) continue
    const path = join(o.tempDir, name)
    const owner = runFolderOwner(path)
    // A run folder is only ours to sweep if it carries the marker; a stray "kAbC123" is not.
    if (!named && owner === undefined) continue
    let entry: Entry
    try {
      entry = stat(path)
    } catch {
      continue
    }
    if (kept.some((k) => k === path || inside(k, path))) { skipped.push({ path, why: 'in use by the process running the clean' }); continue }
    if (entry.dev !== root.dev) { skipped.push({ path, why: 'a mounted volume' }); continue }
    if (now - entry.mtimeMs < maxAge) { fresh += 1; continue }
    if (owner !== undefined && alive(owner)) { skipped.push({ path, why: `its owner, process ${owner}, is still running` }); continue }
    const tree: Measured = entry.directory ? measure(path, root.dev, stat) : { bytes: entry.bytes, newestMs: entry.mtimeMs }
    if (tree.problem) { skipped.push({ path, why: tree.problem }); continue }
    if (now - tree.newestMs < maxAge) { fresh += 1; continue } // something inside was written recently
    items.push({ path, bytes: tree.bytes, kind: 'temp', why: `untouched for ${hours(now - tree.newestMs)}` })
  }
  return { items, skipped, fresh }
}

function planRelease(o: CleanOptions, stat: (path: string) => Entry): { items: CleanItem[]; skipped: CleanSkip[] } {
  const items: CleanItem[] = []
  const skipped: CleanSkip[] = []
  const releaseLink = join(o.repoRoot, 'release')
  const release = realOrUndefined(releaseLink)
  if (!release) return { items, skipped }
  const repo = realOrUndefined(o.repoRoot)
  if (!repo || !inside(release, repo)) {
    return { items, skipped: [{ path: releaseLink, why: 'resolves outside the repo; nothing there is touched' }] }
  }
  const previous = previousPublished(o.currentVersion, o.publishedVersions)
  if (!previous) {
    return { items, skipped: [{ path: releaseLink, why: `no published version below ${o.currentVersion} is known; no release folder is pruned` }] }
  }
  if (o.runningCommands === null) {
    return { items, skipped: [{ path: releaseLink, why: 'running processes could not be listed; no release folder is pruned' }] }
  }
  const fixtures = gateFixturePaths()
  const names = readdirSync(release).filter((name) => !NEVER_UNDER_RELEASE.includes(name))
  for (const name of names.sort()) {
    const version = VERSION_DIR.exec(name)?.[1]
    if (!version || version === o.currentVersion || !isNewerVersion(previous, version)) continue
    const dir = join(release, name)
    let entry: Entry
    try {
      entry = stat(dir)
    } catch {
      continue
    }
    if (!entry.directory) { skipped.push({ path: dir, why: 'not a real folder' }); continue }
    // Matched by the tail of the path, not the whole path: a process may have been started through
    // the release link, the real folder, or a symlinked checkout path. Over-matching only spares more.
    const startedFrom = new RegExp(`/release(\\.noindex)?/${name.replaceAll('.', '\\.')}(/|\\s|$)`)
    if ((o.runningCommands ?? []).some((cmd) => startedFrom.test(cmd))) {
      skipped.push({ path: dir, why: 'a running process was started from it' })
      continue
    }
    const why = `older than the previous published version, v${previous}`
    const kept = fixtures.filter((fixture) => fixture.startsWith(`release/${name}/`)).map((fixture) => fixture.split('/')[2]!)
    for (const fixture of kept) skipped.push({ path: join(dir, fixture), why: 'gate fixture: another suite needs it' })
    const targets = kept.length ? readdirSync(dir).filter((child) => !kept.includes(child)).map((child) => join(dir, child)) : [dir]
    for (const target of targets) {
      const tree = measure(target, entry.dev, stat)
      if (tree.problem) { skipped.push({ path: target, why: tree.problem }); continue }
      items.push({ path: target, bytes: tree.bytes, kind: 'release', why })
    }
  }
  return { items, skipped }
}

/** Decides what a clean would remove. Touches nothing. */
export function planClean(o: CleanOptions): CleanPlan {
  const stat = o.stat ?? statEntry
  const temp = planTemp(o, stat)
  const release = planRelease(o, stat)
  const items = [...release.items, ...temp.items]
  return { items, skipped: [...release.skipped, ...temp.skipped], fresh: temp.fresh, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}

/** Removes a plan's items (or, dry, none of them). An item that is no longer inside the repo or the temp dir is refused. */
export function applyClean(plan: CleanPlan, o: Pick<CleanOptions, 'repoRoot' | 'tempDir'>, dryRun: boolean): CleanResult {
  const removed: CleanItem[] = []
  const failed: { path: string; message: string }[] = []
  if (!dryRun) {
    for (const item of plan.items) {
      if (!isRemovable(item.path, o.repoRoot, o.tempDir)) {
        failed.push({ path: item.path, message: 'refused: outside the repo and the temp dir' })
        continue
      }
      try {
        rmSync(item.path, { recursive: true, force: true })
        removed.push(item)
      } catch (error) {
        failed.push({ path: item.path, message: (error as Error).message })
      }
    }
  }
  return { ...plan, dryRun, removed, failed, freed: removed.reduce((sum, item) => sum + item.bytes, 0) }
}

export interface CleanRunOptions extends CleanOptions {
  readonly dryRun?: boolean
}

export function clean(o: CleanRunOptions): CleanResult {
  return applyClean(planClean(o), o, o.dryRun ?? false)
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** Console lines for a result. Release items are named one by one; temp entries are listed up to `limit`. */
export function formatReport(result: CleanResult, o: { readonly repoRoot: string; readonly tempDir: string; readonly limit?: number }): string[] {
  const shown = (path: string): string => (path.startsWith(o.repoRoot + sep) ? path.slice(o.repoRoot.length + 1) : path)
  const verb = result.dryRun ? 'would remove' : 'removed'
  const done = result.dryRun ? result.items : result.removed
  const lines: string[] = []
  const limit = o.limit ?? 25
  for (const item of done.filter((i) => i.kind === 'release')) lines.push(`${verb}  ${shown(item.path)}  ${formatBytes(item.bytes)}  (${item.why})`)
  const temp = done.filter((i) => i.kind === 'temp')
  for (const item of temp.slice(0, limit)) lines.push(`${verb}  ${shown(item.path)}  ${formatBytes(item.bytes)}  (${item.why})`)
  if (temp.length > limit) lines.push(`${verb}  ... and ${temp.length - limit} more cockpit-* entries in ${o.tempDir}  ${formatBytes(temp.slice(limit).reduce((n, i) => n + i.bytes, 0))}`)
  for (const skip of result.skipped) lines.push(`kept  ${shown(skip.path)}  (${skip.why})`)
  if (result.fresh) lines.push(`kept  ${result.fresh} cockpit-* entr${result.fresh === 1 ? 'y' : 'ies'} newer than ${hours(MAX_AGE_MS)} (or written to within it)`)
  for (const failure of result.failed) lines.push(`warning: could not remove ${shown(failure.path)}: ${failure.message}`)
  const total = result.dryRun ? result.bytes : result.freed
  lines.push(result.dryRun
    ? `dry run: would remove ${result.items.length} item${result.items.length === 1 ? '' : 's'}, freeing ${formatBytes(total)} (${total} bytes). Nothing was removed.`
    : `removed ${result.removed.length} item${result.removed.length === 1 ? '' : 's'}, freed ${formatBytes(total)} (${total} bytes)${result.failed.length ? `; ${result.failed.length} could not be removed` : ''}.`)
  return lines
}

/** Command lines of everything running, or null if ps cannot be read. */
export function listRunningCommands(): string[] | null {
  const result = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout.split('\n') : null
}

/** Published versions: the repo's v<x.y.z> git tags. Empty if git cannot say. */
export function listPublishedVersions(repoRoot: string): string[] {
  const result = spawnSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split('\n').map((tag) => VERSION_DIR.exec(tag.trim())?.[1]).filter((v): v is string => v !== undefined)
}
