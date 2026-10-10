import type { ModelOption } from '../../server/agents/capabilities/types.ts'
import { claudeModels } from '../../server/agents/claude/models.ts'
import { defaultAgyLevel, groupAgyModels, locateAgyModel, resolveAgyModel, type AgyLevel, type AgyModel } from '../../server/agents/antigravity/models.ts'

export interface ModelChoice {
  readonly value: string
  readonly label: string
}

/** The Model and Effort menus for Antigravity once agy has listed its models, shaped like its own picker. */
export interface AgyMenus {
  /** Default, then each model by name; a remembered id agy no longer lists is kept, marked. */
  readonly models: readonly ModelChoice[]
  /** The menu value for the stored choice (a model name; an older stored id maps to its model). */
  readonly selected: string
  /** The chosen model, when agy lists it. */
  readonly model?: AgyModel
  /** The effort shown for it: the stored one, else the stored id's, else its default. */
  readonly level?: AgyLevel
}

/**
 * agy lists one id per model and effort; a menu of all of them repeats every model three times, and
 * an id plus a different effort is refused by agy 1.3.1. So: models by name here, efforts beside them.
 */
export function agyMenus(listed: readonly ModelOption[], model: string, effort: string): AgyMenus {
  const groups = groupAgyModels(listed)
  const found = model ? locateAgyModel(groups, model) : undefined
  const models: ModelChoice[] = [{ value: '', label: 'Default model' }, ...groups.map((g) => ({ value: g.base, label: g.label }))]
  if (!found) return { models: model ? [...models, { value: model, label: `${model} (not listed now)` }] : models, selected: model }
  const asked = found.group.levels.find((l) => l === effort)
  return { models, selected: found.group.base, model: found.group, level: asked ?? found.level ?? defaultAgyLevel(found.group.levels) }
}

/** Choosing a model keeps the effort when that model offers it, else takes the model's default. */
export function agyEffortFor(model: AgyModel | undefined, effort: string): string {
  if (!model || model.levels.length === 0) return ''
  return model.levels.find((l) => l === effort) ?? defaultAgyLevel(model.levels) ?? ''
}

/**
 * The composer chip's words for an Antigravity choice: the model agy will run, by name, and its
 * effort ("Gemini 3.8 Flash · Low"), resolved the way the launch resolves it. None when agy does not
 * list the model or would refuse the effort; the chip then shows the stored value as it is.
 */
export function agyChoiceLabel(listed: readonly ModelOption[], model: string, effort: string): string | undefined {
  const resolved = resolveAgyModel(model, effort || undefined, listed)
  if (!('id' in resolved)) return undefined
  const found = locateAgyModel(groupAgyModels(listed), resolved.id)
  if (!found) return undefined
  return found.level ? `${found.group.label} · ${found.level.charAt(0).toUpperCase()}${found.level.slice(1)}` : found.group.label
}

/** The Model menu value that reveals a box for a full Claude model id. */
export const OTHER_MODEL = '__other__'

/** Before `claude --help` has been read: the aliases it names today. */
const CLAUDE_HELP_ALIASES = ['fable', 'opus', 'sonnet']

/**
 * Claude Code's Model menu: Default, the aliases `claude --help` names (plus Haiku), then Other for a
 * full model id. A stored id that is not an alias shows as Other with the id in its box.
 */
export function claudeMenu(listed: readonly ModelOption[] | undefined, model: string, otherChosen = false): { readonly models: readonly ModelChoice[]; readonly selected: string; readonly other: boolean } {
  const aliases = listed && listed.length > 0 ? listed : claudeModels(CLAUDE_HELP_ALIASES)
  const models = [{ value: '', label: 'Default model' }, ...aliases.map((m) => ({ value: m.id, label: m.label ?? m.id })), { value: OTHER_MODEL, label: 'Other…' }]
  const listedModel = aliases.some((m) => m.id === model)
  const other = otherChosen ? !listedModel || model === '' : model !== '' && !listedModel
  return { models, selected: other ? OTHER_MODEL : model, other }
}
