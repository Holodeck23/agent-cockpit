import type { Effort } from '../claude/flags.ts'

// Codex takes a different set of reasoning levels per model (R7). This is what `codex app-server`
// model/list advertises in codex-cli 0.147, recorded in tests/fixtures/codex-model-list-0.147.json
// (a test keeps the two equal). A blank model means the CLI's own default, which comes from the
// person's Codex config and is not on this list (gpt-6-astra here), so it is treated as unknown.

const UP_TO_MAX: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const CODEX_MODEL_EFFORTS: Readonly<Record<string, readonly Effort[]>> = {
  'gpt-5.6-sol': [...UP_TO_MAX, 'ultra'],
  'gpt-5.6-terra': [...UP_TO_MAX, 'ultra'],
  'gpt-5.6-luna': UP_TO_MAX,
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
}

/** The levels to offer for a Codex model; one with no record gets up to max, never Ultra. */
export function codexEfforts(model?: string): readonly Effort[] {
  return CODEX_MODEL_EFFORTS[model?.trim() ?? ''] ?? UP_TO_MAX
}

/** The level to send: the saved one when the model has it, otherwise the model's highest. */
export function codexEffort(model: string | undefined, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined
  const offered = codexEfforts(model)
  if (offered.includes(effort)) return effort
  const rank = (level: Effort): number => [...UP_TO_MAX, 'ultra'].indexOf(level)
  return offered.filter((level) => rank(level) <= rank(effort)).at(-1) ?? offered.at(-1)
}
