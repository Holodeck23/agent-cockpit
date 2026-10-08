import type { ModelOption } from '../capabilities/types.ts'

/** The efforts agy offers per model, low to high (`agy models`, 1.3.1). */
export const AGY_LEVELS = ['low', 'medium', 'high'] as const
export type AgyLevel = (typeof AGY_LEVELS)[number]

/** One model as Antigravity's own picker shows it: a name, and the efforts it comes in. */
export interface AgyModel {
  readonly base: string
  readonly label: string
  readonly levels: readonly AgyLevel[]
}

const VARIANT = /^(.*) \((Low|Medium|High)\)$/

/**
 * `agy models` lists one id per model and effort ("gemini-3.1-pro-low  Gemini 3.1 Pro (Low)").
 * Grouped by name in agy's order; an entry without that shape is a model of its own.
 */
export function groupAgyModels(listed: readonly ModelOption[]): readonly AgyModel[] {
  const groups: { base: string; label: string; levels: AgyLevel[] }[] = []
  for (const { id, label } of listed) {
    const match = label ? VARIANT.exec(label) : null
    const level = match ? (match[2]!.toLowerCase() as AgyLevel) : undefined
    const base = level && id.endsWith(`-${level}`) ? id.slice(0, -level.length - 1) : id
    const name = level && base !== id ? match![1]! : label ?? id
    const found = groups.find((g) => g.base === base)
    if (found) { if (level && base !== id && !found.levels.includes(level)) found.levels.push(level) }
    else groups.push({ base, label: name, levels: level && base !== id ? [level] : [] })
  }
  return groups.map((g) => ({ ...g, levels: AGY_LEVELS.filter((l) => g.levels.includes(l)) }))
}

/** The model a stored choice names: by name, or by one of its ids (with that id's effort). */
export function locateAgyModel(groups: readonly AgyModel[], model: string): { group: AgyModel; level?: AgyLevel } | undefined {
  for (const group of groups) {
    if (group.base === model) return { group }
    const level = group.levels.find((l) => `${group.base}-${l}` === model)
    if (level) return { group, level }
  }
  return undefined
}

/** Medium where a model offers it, else its highest effort. */
export const defaultAgyLevel = (levels: readonly AgyLevel[]): AgyLevel | undefined => (levels.includes('medium') ? 'medium' : levels.at(-1))

const LEVEL_OF: Record<string, AgyLevel> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', ultra: 'high' }
const title = (level: string): string => level.charAt(0).toUpperCase() + level.slice(1)

/**
 * The single id to pass as `--model`, with no `--effort`: agy 1.3.1 refuses an id together with a
 * different `--effort`, and a model name without one ("requires --effort (available: low, high)").
 */
export function resolveAgyModel(model: string, effort: string | undefined, listed: readonly ModelOption[]): { readonly id: string } | { readonly refused: string } {
  const found = locateAgyModel(groupAgyModels(listed), model)
  if (!found) return { refused: `does not offer the model ${model}` }
  const { group } = found
  if (group.levels.length === 0) return { id: group.base }
  const level = effort ? LEVEL_OF[effort] : found.level ?? defaultAgyLevel(group.levels)
  if (!level || !group.levels.includes(level)) {
    return { refused: `${group.label} offers ${group.levels.map(title).join(' or ')} effort, not ${title(level ?? String(effort))}` }
  }
  return { id: `${group.base}-${level}` }
}
