// How permission modes read in the picker, the gallery and the transcript.
import type { AgentId } from '../../server/agents/types.ts'
import { defaultPermission } from './agent-memory.ts'
import type { ThreadSettings } from './api.ts'

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

export function permissionDescription(agent: AgentId, mode: Mode): string {
  if (agent === 'codex') {
    // Cockpit runs Codex's Accept edits exactly like Manual (codexPolicy: on-request + workspace-write).
    if (mode === 'manual' || mode === 'acceptEdits') return 'Codex can edit inside the workspace. It asks only when it requests escalation; other blocked actions may simply fail.'
    if (mode === 'plan') return 'Read-only sandbox. Codex may ask to escalate an action; review any request before allowing it.'
    if (mode === 'dontAsk' || mode === 'auto') return 'Codex can write in its workspace sandbox without prompting. Actions blocked by the sandbox are refused.'
    return 'Codex runs without its sandbox or approval prompts. It can change files outside this project.'
  }
  if (agent === 'antigravity') return mode === 'bypassPermissions'
    ? 'Antigravity runs without permission prompts. It can change files outside this project.'
    : mode === 'plan' ? 'Antigravity plans without making changes.' : 'Uses Antigravity’s configured policy. Actions that need approval are refused because headless Antigravity cannot ask.'
  const descriptions: Record<Mode, string> = {
    manual: 'The agent asks for actions its permission rules do not already allow.',
    acceptEdits: 'File edits can proceed without asking; other actions follow the agent’s permission rules.',
    plan: 'Ask the agent to investigate and plan without making changes.',
    auto: 'The agent decides which actions need approval using its automatic permission policy.',
    dontAsk: 'No approval prompts. The agent’s existing permission rules determine what runs or is refused.',
    bypassPermissions: 'The agent bypasses its permission checks. It can run commands and change files outside this project without asking.',
  }
  return descriptions[mode]
}

/**
 * Choosing Bypass or Don't ask asks first. Switching to an agent whose own default is that mode
 * (Antigravity: Bypass, since its Manual refuses every write) does not, or every switch would ask.
 */
export function needsPermissionConfirmation(previous: { agent: AgentId; permissionMode: Mode }, next: { agent: AgentId; permissionMode: Mode }): boolean {
  if (next.permissionMode !== 'bypassPermissions' && next.permissionMode !== 'dontAsk') return false
  if (previous.agent !== next.agent) return next.permissionMode !== defaultPermission(next.agent)
  return previous.permissionMode !== next.permissionMode
}
