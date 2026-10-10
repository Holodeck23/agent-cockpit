// A turn that ended without a reply after a step was refused. Antigravity (and Codex's sandbox)
// refuse without asking, so the turn reads as finished with nothing said; this says why, in the
// mode the turn ran in, and what to switch to for that mode.
import type { AgentId } from '../../server/agents/types.ts'
import type { ThreadSettings } from './api.ts'
import { permissionLabel } from './permission-labels.ts'

type Mode = ThreadSettings['permissionMode']

const quoted = (agent: AgentId, mode: Mode): string => `“${permissionLabel(agent, mode)}”`

function switchAdvice(agent: AgentId, mode: Mode): string {
  const now = `This conversation is on ${quoted(agent, mode)}`
  if (mode === 'bypassPermissions') return `${now}, so switching permissions will not change it.`
  if (agent === 'antigravity') {
    if (mode === 'plan') return `${now}, which keeps Antigravity from running commands or changing files, and it cannot ask you. To let it, switch to ${quoted(agent, 'bypassPermissions')}. ${quoted(agent, 'manual')} allows only what your Antigravity settings already allow.`
    return `${now}, which refuses anything those settings do not already allow, because Antigravity cannot ask you. Switch to ${quoted(agent, 'bypassPermissions')}, or allow it in Antigravity’s settings.`
  }
  if (agent === 'codex') {
    if (mode === 'plan') return `${now}, a read-only sandbox. Switch to ${quoted(agent, 'manual')} to let Codex edit inside the workspace.`
    return `${now}, and Codex’s workspace sandbox blocked it. ${quoted(agent, 'bypassPermissions')} runs it without the sandbox.`
  }
  if (mode === 'plan' || mode === 'dontAsk') return `${now}, which refuses without asking you. Switch to ${quoted(agent, 'manual')} so ${agent === 'opencode' ? 'OpenCode' : 'Claude Code'} can ask.`
  return `${now}. Send your message again and allow the step when it asks.`
}

/** `refused` is the refused step's label, e.g. "running npm run typecheck". */
export function refusedTurnNote(agent: AgentId, agentLabel: string, mode: Mode | undefined, refused: string): string {
  const what = `${agentLabel} stopped without replying after a step was not allowed (${refused}).`
  return mode ? `${what} ${switchAdvice(agent, mode)}` : `${what} Check this conversation’s permissions.`
}
