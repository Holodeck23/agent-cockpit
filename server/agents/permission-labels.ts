// How permission modes read, shared by the web views and the server's notes to agents.
import type { ThreadSettings } from '../threads/types.ts'
import type { AgentId } from './types.ts'

type Mode = ThreadSettings['permissionMode']

export const PERMISSION_LABEL: Record<Mode, string> = {
  manual: 'Ask before acting',
  acceptEdits: 'Edit files without asking',
  plan: 'Plan only, no changes',
  auto: 'Auto',
  dontAsk: 'Never ask',
  bypassPermissions: 'Bypass all permissions',
}

/** Antigravity cannot ask: its `manual` is its own configured policy (no flag from Cockpit). */
export function permissionLabel(agent: AgentId, mode: Mode): string {
  if (agent === 'antigravity' && mode === 'manual') return 'Configured permissions (Antigravity settings)'
  if (agent === 'antigravity' && mode === 'bypassPermissions') return 'Bypass permissions'
  return PERMISSION_LABEL[mode]
}
