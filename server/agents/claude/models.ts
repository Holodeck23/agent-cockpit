import type { ModelOption } from '../capabilities/types.ts'

/**
 * The aliases `claude --help` gives for --model, then Haiku: help names only examples ("e.g.") and
 * Claude Code takes `haiku` too. A full model id goes in the picker's Other.
 */
export function claudeModels(aliases: readonly string[]): ModelOption[] {
  const ids = [...new Set([...aliases, 'haiku'])]
  return ids.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))
}
