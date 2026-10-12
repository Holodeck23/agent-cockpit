// Managed account profiles isolate provider credentials and native configuration. The one exception
// is the provider's standard global instruction entry file: it remains the user's rules authority
// no matter which account is selected. Nothing else from the default profile is copied or linked.
import { lstatSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '../types.ts'

const ENTRY: Readonly<Partial<Record<AgentId, { readonly source: readonly string[]; readonly target: string }>>> = {
  claude: { source: ['.claude', 'CLAUDE.md'], target: 'CLAUDE.md' },
  codex: { source: ['.codex', 'AGENTS.md'], target: 'AGENTS.md' },
}

export type SharedInstructions = 'linked' | 'existing' | 'missing' | 'unsupported'

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Gives a managed profile the same standard global rules entry point as the CLI default.
 * Existing profile-owned files (including broken symlinks) always win and are never replaced.
 */
export function ensureSharedInstructions(agent: AgentId, profileDir: string, homeDir: string): SharedInstructions {
  const entry = ENTRY[agent]
  if (!entry) return 'unsupported'
  const source = join(homeDir, ...entry.source)
  try {
    if (!statSync(source).isFile()) return 'missing'
  } catch (error) {
    if (missing(error)) return 'missing'
    throw error
  }

  const target = join(profileDir, entry.target)
  try {
    lstatSync(target)
    return 'existing'
  } catch (error) {
    if (!missing(error)) throw error
  }

  try {
    symlinkSync(source, target)
    return 'linked'
  } catch (error) {
    // Another process may have created the entry between the lstat and symlink. Preserve it.
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') return 'existing'
    throw error
  }
}
