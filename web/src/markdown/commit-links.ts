// Commit hashes in agent replies (G3). A code span that is exactly a hash links, and so does the
// hash after "commit" in prose. A hash needs a letter and a digit, so words and numbers stay text.
// Whether it is really a commit is asked of the project's repository when clicked.
import { linkInProse } from './prose-links.ts'

export const COMMIT_SCHEME = 'cockpit-commit:'

export const isCommitHash = (text: string): boolean => /^[0-9a-f]{7,40}$/.test(text) && /[a-f]/.test(text) && /\d/.test(text)

export const commitOf = (url: string): string | undefined => {
  const hash = url.startsWith(COMMIT_SCHEME) ? url.slice(COMMIT_SCHEME.length) : ''
  return isCommitHash(hash) ? hash : undefined
}

const AFTER_COMMIT = /\bcommit(?:ted)?\s+(?:as\s+)?([0-9a-f]{7,40})\b/gi

export const linkCommitsInProse = linkInProse(AFTER_COMMIT, (m) => (isCommitHash(m[1]!) ? { url: `${COMMIT_SCHEME}${m[1]!}`, text: m[1]! } : undefined))
