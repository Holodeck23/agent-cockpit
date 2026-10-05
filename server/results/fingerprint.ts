import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { readWorktreeFile } from '../git/changes.ts'
import { observe, type Observation } from '../git/observe.ts'

// What a check was run against (W7.4): the workspace, its HEAD and branch, every uncommitted path's
// content fingerprint (tracked and untracked), and the check's declared inputs hashed one by one.
// Bounded so it never indexes a disk; anything left out or moving while read makes freshness
// unknown. Two fingerprints are equal only when every part is: a pass at one never certifies another.

export const MAX_DECLARED_INPUTS = 50
export const MAX_INPUT_FILES = 2000
export const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_INPUT_FILE = 4 * 1024 * 1024
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

export interface InputHash { readonly path: string; readonly hash: string }

export interface SubjectFingerprint {
  readonly workspace: string
  readonly repo: boolean
  readonly head: string | null
  readonly branch: string | null
  /** sha256 over the uncommitted paths and their content fingerprints. */
  readonly worktree: string
  readonly dirtyPaths: number
  readonly inputs: readonly InputHash[]
  /** sha256 over all of the above. */
  readonly digest: string
  /** Complete only when nothing relevant was omitted and nothing moved while it was read. */
  readonly coverage: { readonly complete: boolean; readonly omitted: readonly string[] }
  readonly takenAt: string
}

/** A declared input: a path inside the workspace, never absolute and never leaving it. */
export function safeInputPath(path: string): string | undefined {
  const clean = normalize(path.trim()).replace(/\/+$/, '')
  if (!clean || clean === '.' || clean.startsWith('/') || clean === '..' || clean.startsWith('../') || clean.includes('\0')) return undefined
  return clean
}

function hashInputs(workspace: string, declared: readonly string[]): { inputs: InputHash[]; omitted: string[] } {
  const inputs: InputHash[] = []
  const omitted: string[] = []
  let files = 0
  let bytes = 0
  const add = (path: string): void => {
    if (files >= MAX_INPUT_FILES || bytes >= MAX_INPUT_BYTES) { omitted.push(`${path} (over the ${MAX_INPUT_FILES}-file or ${MAX_INPUT_BYTES / 1024 / 1024} MiB bound)`); return }
    const read = readWorktreeFile(workspace, path, Math.min(MAX_INPUT_FILE, MAX_INPUT_BYTES - bytes))
    files++
    switch (read.kind) {
      case 'file':
        bytes += read.bytes.length
        inputs.push({ path, hash: createHash('sha256').update(read.bytes).digest('hex') })
        return
      case 'symlink': inputs.push({ path, hash: `link:${read.target}` }); return
      case 'missing': inputs.push({ path, hash: 'missing' }); return
      case 'too-large': omitted.push(`${path} (too large to hash)`); return
      default: omitted.push(`${path} (not a regular file inside the workspace)`)
    }
  }
  const walk = (path: string): void => {
    let stat
    try { stat = lstatSync(join(workspace, path)) } catch { add(path); return }
    if (!stat.isDirectory()) { add(path); return }
    let names: string[]
    try { names = readdirSync(join(workspace, path)).sort() } catch { omitted.push(`${path} (unreadable folder)`); return }
    for (const name of names) {
      if (SKIPPED_DIRS.has(name)) continue
      if (files >= MAX_INPUT_FILES) { omitted.push(`${path} (over the ${MAX_INPUT_FILES}-file bound)`); return }
      walk(`${path}/${name}`)
    }
  }
  for (const raw of declared.slice(0, MAX_DECLARED_INPUTS)) {
    const path = safeInputPath(raw)
    if (!path) { omitted.push(`${raw} (outside the workspace)`); continue }
    walk(path)
  }
  if (declared.length > MAX_DECLARED_INPUTS) omitted.push(`${declared.length - MAX_DECLARED_INPUTS} more declared inputs`)
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { inputs, omitted }
}

const sha = (parts: readonly string[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

export function fingerprintOf(workspace: string, observation: Observation, declared: readonly string[]): SubjectFingerprint {
  const first = hashInputs(workspace, declared)
  // Inputs are read twice, like the observation: one that moved in between is not a stable subject.
  const second = hashInputs(workspace, declared)
  const moved = JSON.stringify(first.inputs) !== JSON.stringify(second.inputs)
  const worktree = sha(observation.files.flatMap((f) => [f.path, f.oldPath ?? '', f.status, f.fingerprint]))
  const omitted = [
    ...second.omitted,
    ...(observation.truncated ? ['Uncommitted paths past the observation bound'] : []),
    ...(!observation.stable ? ['Files were changing while Cockpit read them'] : []),
    ...(moved ? ['A declared input changed while Cockpit read it'] : []),
  ]
  const base = { workspace, repo: observation.repo, head: observation.head, branch: observation.branch, worktree, dirtyPaths: observation.files.length, inputs: second.inputs }
  return {
    ...base,
    digest: sha([workspace, String(base.repo), base.head ?? '', base.branch ?? '', worktree, ...second.inputs.flatMap((i) => [i.path, i.hash])]),
    coverage: { complete: omitted.length === 0, omitted },
    takenAt: new Date().toISOString(),
  }
}

export async function takeFingerprint(workspace: string, declared: readonly string[], look: (path: string) => Promise<Observation> = observe): Promise<SubjectFingerprint> {
  return fingerprintOf(workspace, await look(workspace), declared)
}

export type Freshness =
  | { readonly state: 'fresh' }
  | { readonly state: 'stale'; readonly reasons: readonly string[] }
  | { readonly state: 'unknown'; readonly reasons: readonly string[] }

/** Whether a check taken at `then` still describes the workspace at `now`. */
export function freshness(then: SubjectFingerprint, now: SubjectFingerprint): Freshness {
  const reasons: string[] = []
  if (then.head !== now.head) reasons.push('A different commit is checked out.')
  if (then.branch !== now.branch) reasons.push('The branch changed.')
  if (then.worktree !== now.worktree) reasons.push('Uncommitted files changed.')
  const was = new Map(then.inputs.map((i) => [i.path, i.hash]))
  const is = new Map(now.inputs.map((i) => [i.path, i.hash]))
  const edited = [...new Set([...was.keys(), ...is.keys()])].filter((p) => was.get(p) !== is.get(p)).sort()
  if (edited.length) reasons.push(`Declared input${edited.length === 1 ? '' : 's'} changed: ${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ` and ${edited.length - 5} more` : ''}.`)
  if (reasons.length || then.digest !== now.digest) return { state: 'stale', reasons: reasons.length ? reasons : ['The workspace differs from when the check ran.'] }
  if (!then.coverage.complete || !now.coverage.complete) return { state: 'unknown', reasons: [...new Set([...then.coverage.omitted, ...now.coverage.omitted])] }
  return { state: 'fresh' }
}
