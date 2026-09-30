import type { AgentId } from './types.ts'

const PRODUCT_NAMES: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Turns a failed spawn into a message a user can act on; a missing CLI is the common case. */
export function startErrorMessage(agent: AgentId, error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') {
    return `${PRODUCT_NAMES[agent]} isn't installed or isn't on PATH. Install it and sign in, then restart Cockpit.`
  }
  return `Could not start ${agent}: ${error.message}`
}
