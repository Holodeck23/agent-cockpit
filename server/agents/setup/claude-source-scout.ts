// Candidate locations only. Native discovery and precedence must be measured before completeness is true.
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ClaudeSourceKind = 'settings' | 'instruction' | 'mcp' | 'skill-root' | 'agent-root' | 'rule-root'
  | 'memory-root' | 'plugin-registry' | 'policy' | 'profile-root' | 'workspace-root' | 'config-root'
export type ClaudeSourceState = 'file' | 'directory' | 'link' | 'missing' | 'unexpected'
export interface ClaudeSourceCandidate {
  readonly id: string
  readonly kind: ClaudeSourceKind
  readonly scope: 'policy' | 'profile' | 'project'
  /** Private host-side locator; never send this record directly to a renderer or evidence export. */
  readonly path: string
  readonly state: ClaudeSourceState
  readonly depth?: number
}

const sourceId = (kind: ClaudeSourceKind, scope: ClaudeSourceCandidate['scope'], path: string): string =>
  createHash('sha256').update(kind).update('\0').update(scope).update('\0').update(path).digest('hex')

function state(path: string): ClaudeSourceState {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'link'
    if (stat.isFile()) return 'file'
    if (stat.isDirectory()) return 'directory'
    return 'unexpected'
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** No source content, plugin execution, account resolution or profile writes. */
export function scoutClaudeSources(input: { readonly home: string; readonly profileDir: string;
  readonly workspaceRoot: string; readonly cwd: string }): readonly ClaudeSourceCandidate[] {
  const home = resolve(input.home), profile = resolve(input.profileDir)
  const root = resolve(input.workspaceRoot), cwd = resolve(input.cwd)
  const fromRoot = relative(root, cwd)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Claude source scout cwd leaves the selected workspace')
  }
  const out: ClaudeSourceCandidate[] = []
  const add = (kind: ClaudeSourceKind, scope: ClaudeSourceCandidate['scope'], path: string, depth?: number): void => {
    out.push({ id: sourceId(kind, scope, path), kind, scope, path, state: state(path), ...(depth === undefined ? {} : { depth }) })
  }
  for (const path of ['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json']) {
    add('policy', 'policy', path)
  }
  add('profile-root', 'profile', profile)
  for (const name of ['settings.json', 'settings.local.json']) add('settings', 'profile', join(profile, name))
  add('mcp', 'profile', join(profile === join(home, '.claude') ? home : profile, '.claude.json'))
  add('instruction', 'profile', join(profile, 'CLAUDE.md'))
  for (const [kind, name] of [['skill-root', 'skills'], ['agent-root', 'agents'], ['rule-root', 'rules'],
    ['memory-root', 'projects']] as const) add(kind, 'profile', join(profile, name))
  add('plugin-registry', 'profile', join(profile, 'plugins', 'installed_plugins.json'))

  const ancestors: string[] = []
  for (let current = cwd; ; current = dirname(current)) {
    ancestors.unshift(current)
    if (current === root) break
  }
  for (const [depth, dir] of ancestors.entries()) {
    if (depth === 0) add('workspace-root', 'project', dir, depth)
    add('config-root', 'project', join(dir, '.claude'), depth)
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) add('instruction', 'project', join(dir, name), depth)
    add('instruction', 'project', join(dir, '.claude', 'CLAUDE.md'), depth)
    for (const name of ['settings.json', 'settings.local.json']) add('settings', 'project', join(dir, '.claude', name), depth)
    add('mcp', 'project', join(dir, '.mcp.json'), depth)
    for (const [kind, name] of [['skill-root', 'skills'], ['agent-root', 'agents'], ['rule-root', 'rules']] as const) {
      add(kind, 'project', join(dir, '.claude', name), depth)
    }
  }
  return out
}
