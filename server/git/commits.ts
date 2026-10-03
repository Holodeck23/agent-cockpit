// Commit hashes in agent replies (G3): is it a commit in this project, and where is its web page?
// Only hashes reach git (never names, ranges or options), and only known hosts get a page.
import { insideRepository, run } from './branches.ts'

const HASH = /^[0-9a-f]{7,40}$/i
const PAGES: Readonly<Record<string, (base: string, hash: string) => string>> = {
  'github.com': (base, hash) => `${base}/commit/${hash}`,
  'gitlab.com': (base, hash) => `${base}/-/commit/${hash}`,
  'bitbucket.org': (base, hash) => `${base}/commits/${hash}`,
}

/** The repository's web address for a GitHub, GitLab or Bitbucket remote, credentials dropped. */
export function remoteWebUrl(remote: string): string | undefined {
  let host: string
  let path: string
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote.trim())
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let url: URL
    try { url = new URL(remote.trim()) } catch { return undefined }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined
    host = url.hostname
    path = url.pathname.replace(/^\/+/, '')
  }
  host = host.toLowerCase()
  if (!PAGES[host]) return undefined
  path = path.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return undefined
  return `https://${host}/${path}`
}

export interface CommitLink { readonly hash: string; readonly url?: string }

/** The full hash when `hash` names a commit in the project's repository, with its page if the remote has one. */
export async function findCommit(projectPath: string, hash: string): Promise<CommitLink | undefined> {
  if (!HASH.test(hash) || !insideRepository(projectPath)) return undefined
  let full: string
  try {
    full = (await run(projectPath, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`])).stdout.trim()
  } catch {
    return undefined
  }
  if (!/^[0-9a-f]{40}$/.test(full)) return undefined
  const remotes = (await run(projectPath, ['remote']).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined
  if (!remote) return { hash: full }
  const base = remoteWebUrl((await run(projectPath, ['remote', 'get-url', remote]).catch(() => ({ stdout: '' }))).stdout)
  const host = base ? new URL(base).hostname : undefined
  return base && host && PAGES[host] ? { hash: full, url: PAGES[host](base, full) } : { hash: full }
}
