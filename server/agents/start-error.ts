import type { AgentId } from './types.ts'

const PRODUCT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
}

/** Turns a failed spawn into a message a user can act on; a missing CLI is the common case. */
export function startErrorMessage(agent: AgentId, error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') {
    // Since wave 10 Agent settings installs (or shows how to install) every CLI; no restart is needed.
    return `${PRODUCT_NAMES[agent]} isn't installed or isn't on PATH. Install it from Agent settings, or switch this conversation to another agent.`
  }
  if (error.code === 'EACCES') {
    return `${PRODUCT_NAMES[agent]} cannot be executed. Check the CLI's executable permissions or reinstall it, then retry.`
  }
  return `Could not start ${agent}: ${error.message}`
}
