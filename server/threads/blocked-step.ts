import type { StoredEvent, ThreadSettings } from './types.ts'
import { isRefusal } from './refusals.ts'

// No dead turns. Antigravity ends its turn itself at the first step its permission policy refuses,
// without a word (agy 1.3.3), and no instruction changes that. A second message in the same session
// does get a reply, so Cockpit sends one, once, asking it to report. Pure; the manager sends it.

const ENDS_TURN = new Set(['result', 'exit', 'error', 'session_boundary', 'agent_switch'])
/** Refusals you made (a Cockpit card): you already know; only the agent's own policy is reported. */
const BY_YOU = /denied from agent cockpit|denied by the user|doesn't want to proceed|tool use was rejected/i

/** On for Antigravity unless turned off; other agents end their turns with a reply. */
export function reportsBlockedSteps(settings: Pick<ThreadSettings, 'agent' | 'reportBlocked'>): boolean {
  return settings.agent === 'antigravity' && settings.reportBlocked !== false
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function field(input: unknown, ...keys: string[]): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** "running `find . -maxdepth 1`", "read_file /p/a.md", else the tool's name. */
export function stepLabel(name: string, input: unknown): string {
  const command = field(input, 'CommandLine', 'command', 'cmd')
  if (command) return `running \`${clip(command, 80)}\``
  const path = field(input, 'AbsolutePath', 'file_path', 'path', 'TargetFile', 'DirectoryPath', 'Url', 'url')
  return path ? `${name} ${clip(path, 120)}` : name
}

/**
 * The follow-up for a turn that just ended, or undefined when none is owed. `events` ends with the
 * turn's result. Owed only when ALL hold: the result is a success with no text; the turn has no
 * message from the agent; one of its steps was refused by the agent's own policy (never `denied` on
 * the result alone: agy lists every denial of the session there); and Cockpit did not start it.
 */
export function blockedStepFollowUp(events: readonly StoredEvent[], modeLabel: string): string | undefined {
  const result = events.at(-1)?.event
  if (result?.kind !== 'result' || !result.ok || result.stopped || result.interrupted || (result.text ?? '').trim() !== '') return undefined
  let start = events.length - 1
  while (start > 0 && !ENDS_TURN.has(events[start - 1]!.event.kind)) start -= 1
  const turn = events.slice(start, -1).map((e) => e.event)
  if (!turn.some((e) => e.kind === 'user_text')) return undefined
  if (turn.some((e) => (e.kind === 'user_text' && e.fromCockpit) || (e.kind === 'assistant_text' && e.text.trim() !== ''))) return undefined
  const refused = turn.find((e) => e.kind === 'tool_result' && e.isError && isRefusal(e.content) && !BY_YOU.test(e.content))
  if (refused?.kind !== 'tool_result') return undefined
  const step = turn.find((e) => e.kind === 'tool_use' && e.id === refused.toolUseId)
  const label = step?.kind === 'tool_use' ? stepLabel(step.name, step.input) : result.denied?.[0]?.label ?? 'a step'
  return `Cockpit note: your last step (${label}) was blocked by this conversation's permission mode (${modeLabel}), not by the user. `
    + 'Without running any more tools, tell the user in two or three sentences what you were trying to do, what was blocked, and what you can say without it.'
}
