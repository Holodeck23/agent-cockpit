import type { ModelOption } from '../../server/agents/capabilities/types.ts'

export interface ModelChoice {
  readonly value: string
  readonly label: string
}

/**
 * The Model menu for an agent whose CLI lists its models (Antigravity: `agy models`): the default,
 * every listed model by name, and a remembered id the CLI no longer lists, so it is never dropped unseen.
 * A menu rather than a text box with suggestions: those filter to what is typed, hiding the rest.
 */
export function modelChoices(listed: readonly ModelOption[], current: string): readonly ModelChoice[] {
  const choices: ModelChoice[] = [{ value: '', label: 'Default model' }, ...listed.map((m) => ({ value: m.id, label: m.label ?? m.id }))]
  return current && !listed.some((m) => m.id === current) ? [...choices, { value: current, label: `${current} (not listed now)` }] : choices
}
