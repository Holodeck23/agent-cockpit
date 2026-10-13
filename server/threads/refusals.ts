// Shared by the transcript (web/src/transcript.ts) and the server (turn outcomes, the blocked-step
// follow-up), so both read the same tool result as a refusal.

/**
 * A tool result that says you (or the agent's own permission policy) refused the call, in each
 * agent's words: Cockpit's card, Claude Code, Antigravity, ACP, Codex's `declined`. An OS
 * "Permission denied" from a command that did run is not one.
 */
export function isRefusal(content: string): boolean {
  return /^(denied|declined)$|denied from agent cockpit|denied permission|has been denied|denied by the user|doesn't want to proceed|tool use was rejected/i.test(content.trim())
}
