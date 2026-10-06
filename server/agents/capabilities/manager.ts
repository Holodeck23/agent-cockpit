// Which installer owns an executable, from its resolved path (G-LIFECYCLE "Selected mechanism").
// Order 13 updates through this manager and never installs a second copy beside it.
import { join } from 'node:path'
import type { AgentId } from '../types.ts'
import type { InstallManager } from './types.ts'

const manager = (kind: InstallManager['kind'], label: string): InstallManager => ({ kind, label })

export function detectManager(agent: AgentId, realpath: string, home: string): InstallManager {
  const under = (...parts: string[]): boolean => realpath.startsWith(join(home, ...parts) + '/')
  const caskroom = /\/Caskroom\/([^/]+)\//.exec(realpath)?.[1]
  if (agent === 'claude') {
    if (under('.local', 'share', 'claude', 'versions')) return manager('native', 'Claude Code native installer')
    if (realpath.includes('/node_modules/@anthropic-ai/claude-code/')) return manager('npm', 'npm (global)')
    if (caskroom?.startsWith('claude-code')) return manager('homebrew', 'Homebrew')
  }
  if (agent === 'codex') {
    if (caskroom === 'codex') return manager('homebrew', 'Homebrew')
    if (under('.codex', 'packages', 'standalone')) return manager('standalone', 'Codex standalone installer')
    if (realpath.includes('/node_modules/@openai/codex/')) return manager('npm', 'npm (global)')
    if (realpath.includes('/.bun/')) return manager('npm', 'bun (global)')
  }
  if (agent === 'antigravity' && realpath === join(home, '.local', 'bin', 'agy')) return manager('native', 'Antigravity installer')
  return manager('unknown', 'Unknown installer')
}
