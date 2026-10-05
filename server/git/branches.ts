import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The project's Git branch, as the composer's branch pill shows it, and the three
// branch actions it offers. Everything runs the person's own git in the project
// folder: their config, credentials and hooks. A branch is project-wide, so it
// changes what every conversation in that folder works on.

export interface GitState {
  readonly repo: boolean
  /** Current branch; absent when HEAD is detached (then `head` says where). */
  readonly branch?: string
  /** Short commit id of HEAD; absent in a repository with no commits yet. */
  readonly head?: string
  /** Local branches, most recently committed first. */
  readonly branches: readonly string[]
  readonly upstream?: string
  readonly ahead?: number
  readonly behind?: number
  /** Uncommitted changes (tracked and untracked), as paths; the first few only. */
  readonly changes: readonly string[]
  readonly changeCount: number
}

export class GitError extends Error {}

const MAX_BRANCHES = 200
const MAX_CHANGES = 20
const READ_TIMEOUT_MS = 15_000
const PUSH_TIMEOUT_MS = 90_000
// Never wait on a terminal prompt; keep reads from taking locks an agent's git might need.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

/** Credentials can appear in remote URLs inside git's messages. */
export function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
}

/** `encoding: 'buffer'` returns stdout as a Buffer (typed as string; the caller casts it back). */
export function run(cwd: string, args: readonly string[], timeout = READ_TIMEOUT_MS, maxBuffer = 2_000_000, encoding: 'utf8' | 'buffer' = 'utf8'): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV }, timeout, maxBuffer, encoding: encoding as BufferEncoding }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout: stdout as string, stderr: String(stderr) }); return }
      const killed = (error as { killed?: boolean }).killed
      if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new GitError(`git ${args[0]} printed more than ${Math.round(maxBuffer / 1_000_000)} MB and was stopped`)); return }
      const detail = killed ? `git ${args[0]} took longer than ${Math.round(timeout / 1000)} s and was stopped` : String(stderr).trim() || error.message
      reject(new GitError(redact(detail).slice(0, 800)))
    })
  })
}

/**
 * Looks for a .git entry from the folder up, without running git: a folder that is not a
 * repository never starts git (on a Mac without developer tools, that opens an install prompt).
 */
export function insideRepository(projectPath: string): boolean {
  for (let dir = projectPath; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true
    if (dirname(dir) === dir) return false
  }
}

/** The path of one `git status --porcelain=v2` entry. */
function changedPath(line: string): string {
  const fields = line.split(' ')
  if (line.startsWith('1 ')) return fields.slice(8).join(' ')
  if (line.startsWith('2 ')) return fields.slice(9).join(' ').split('\t')[0] ?? ''
  if (line.startsWith('u ')) return fields.slice(10).join(' ')
  return line.slice(2) // '? path' and '! path'
}

export function parseStatus(output: string): Omit<GitState, 'repo' | 'branches'> {
  let branch: string | undefined
  let head: string | undefined
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  const changes: string[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length)
      branch = name === '(detached)' ? undefined : name
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length)
      head = oid === '(initial)' ? undefined : oid.slice(0, 7)
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (match) { ahead = Number(match[1]); behind = Number(match[2]) }
    } else if (!line.startsWith('#')) {
      changes.push(changedPath(line))
    }
  }
  return {
    ...(branch ? { branch } : {}), ...(head ? { head } : {}), ...(upstream ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}),
    changes: changes.slice(0, MAX_CHANGES), changeCount: changes.length,
  }
}

const NOT_A_REPO: GitState = { repo: false, branches: [], changes: [], changeCount: 0 }

export async function gitState(projectPath: string): Promise<GitState> {
  if (!insideRepository(projectPath)) return NOT_A_REPO
  const [status, refs] = await Promise.all([
    run(projectPath, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    run(projectPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `--count=${MAX_BRANCHES}`, 'refs/heads']),
  ])
  const branches = refs.stdout.split('\n').filter(Boolean)
  return { repo: true, branches, ...parseStatus(status.stdout) }
}

function describeChanges(state: GitState): string {
  const listed = state.changes.slice(0, 3).join(', ')
  const more = state.changeCount > 3 ? ` and ${state.changeCount - 3} more` : ''
  return `${state.changeCount} uncommitted change${state.changeCount === 1 ? '' : 's'} (${listed}${more})`
}

async function requireRepo(projectPath: string): Promise<GitState> {
  const state = await gitState(projectPath)
  if (!state.repo) throw new GitError('This folder is not a Git repository')
  return state
}

/** Switches to an existing local branch. Refused with uncommitted changes, which would follow or block the switch. */
export async function switchBranch(projectPath: string, branch: string): Promise<GitState> {
  const state = await requireRepo(projectPath)
  if (!state.branches.includes(branch)) throw new GitError(`No local branch called ${branch}`)
  if (branch === state.branch) return state
  if (state.changeCount > 0) throw new GitError(`Commit or stash first: ${describeChanges(state)}`)
  await run(projectPath, ['switch', '--no-guess', branch])
  return gitState(projectPath)
}

/** Creates a branch at HEAD and switches to it. Uncommitted changes come along unchanged. */
export async function createBranch(projectPath: string, name: string): Promise<GitState> {
  const state = await requireRepo(projectPath)
  if (!name || name.startsWith('-') || /\s/.test(name)) throw new GitError(`Not a valid branch name: ${name}`)
  try {
    await run(projectPath, ['check-ref-format', '--branch', name])
  } catch {
    throw new GitError(`Not a valid branch name: ${name}`)
  }
  if (state.branches.includes(name)) throw new GitError(`A branch called ${name} already exists`)
  await run(projectPath, ['switch', '-c', name])
  return gitState(projectPath)
}

export interface PushResult {
  readonly state: GitState
  /** Where it went, e.g. "origin/main". */
  readonly to: string
}

/** Pushes the current branch to its upstream, or sets one on origin (or the only remote). */
export async function pushBranch(projectPath: string): Promise<PushResult> {
  const state = await requireRepo(projectPath)
  if (!state.branch) throw new GitError('HEAD is not on a branch, so there is nothing to push')
  if (!state.head) throw new GitError('This branch has no commits yet')
  if (state.upstream) {
    await run(projectPath, ['push'], PUSH_TIMEOUT_MS)
    return { state: await gitState(projectPath), to: state.upstream }
  }
  const remotes = (await run(projectPath, ['remote'])).stdout.split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined
  if (!remote) {
    throw new GitError(remotes.length === 0 ? 'This repository has no remote to push to' : `Several remotes and none called origin (${remotes.join(', ')}); push from Terminal`)
  }
  await run(projectPath, ['push', '-u', remote, state.branch], PUSH_TIMEOUT_MS)
  return { state: await gitState(projectPath), to: `${remote}/${state.branch}` }
}
