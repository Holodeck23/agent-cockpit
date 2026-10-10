import { describe, expect, it } from 'vitest'
import { agyChoiceLabel, agyEffortFor, agyMenus, claudeMenu, OTHER_MODEL } from '../web/src/model-choices.ts'
import { claudeModels } from '../server/agents/claude/models.ts'

const listed = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]

describe('the Antigravity Model menu, shaped like Antigravity\'s own', () => {
  it('lists each model once by name, after Default, whatever is chosen', () => {
    expect(agyMenus(listed, '', '').models).toEqual([
      { value: '', label: 'Default model' },
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
    ])
  })

  it('shows a chosen model with its effort, and an id remembered from before as its model and effort', () => {
    expect(agyMenus(listed, 'gemini-3.1-pro', 'low')).toMatchObject({ selected: 'gemini-3.1-pro', level: 'low', model: { levels: ['low', 'high'] } })
    expect(agyMenus(listed, 'gemini-3.8-flash-low', '')).toMatchObject({ selected: 'gemini-3.8-flash', level: 'low' })
    expect(agyMenus(listed, 'gemini-3.1-pro', '')).toMatchObject({ level: 'high' })
  })

  it('keeps a remembered model agy no longer lists, marked, so the choice is not silently lost', () => {
    const menus = agyMenus(listed, 'gemini-3.6-flash-low', '')
    expect(menus.models.at(-1)).toEqual({ value: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low (not listed now)' })
    expect(menus.selected).toBe('gemini-3.6-flash-low')
    expect(menus.model).toBeUndefined()
  })

  it('choosing a model keeps the effort when it offers it, else takes its default', () => {
    const pro = agyMenus(listed, 'gemini-3.1-pro', '').model
    expect(agyEffortFor(pro, 'low')).toBe('low')
    expect(agyEffortFor(pro, 'medium')).toBe('high')
    expect(agyEffortFor(agyMenus(listed, 'gpt-oss-120b', '').model, 'high')).toBe('medium')
    expect(agyEffortFor(undefined, 'high')).toBe('')
  })
})

describe('the composer chip for an Antigravity choice', () => {
  it('names the model agy will run, with its effort, never the id', () => {
    expect(agyChoiceLabel(listed, 'gemini-3.8-flash-low', '')).toBe('Gemini 3.8 Flash · Low')
    expect(agyChoiceLabel(listed, 'gemini-3.1-pro', 'low')).toBe('Gemini 3.1 Pro · Low')
    expect(agyChoiceLabel(listed, 'gemini-3.1-pro', '')).toBe('Gemini 3.1 Pro · High')
    expect(agyChoiceLabel(listed, 'gpt-oss-120b', '')).toBe('GPT-OSS 120B · Medium')
  })

  it('has no name for a model agy no longer lists, or an effort it would refuse', () => {
    expect(agyChoiceLabel(listed, 'gemini-2-ultra', '')).toBeUndefined()
    expect(agyChoiceLabel(listed, 'gemini-3.1-pro', 'medium')).toBeUndefined()
    expect(agyChoiceLabel([], 'gemini-3.1-pro', 'low')).toBeUndefined()
  })
})

describe('Claude Code model menu', () => {
  const listed = claudeModels(['fable', 'opus', 'sonnet'])

  it('is Default, the --help aliases, Haiku, then Other', () => {
    expect(claudeMenu(listed, '').models.map((m) => m.label)).toEqual(['Default model', 'Fable', 'Opus', 'Sonnet', 'Haiku', 'Other…'])
    expect(claudeMenu(listed, 'opus')).toMatchObject({ selected: 'opus', other: false })
  })

  it('shows a full model id as Other, with its box', () => {
    expect(claudeMenu(listed, 'claude-opus-5-5')).toMatchObject({ selected: OTHER_MODEL, other: true })
  })

  it('keeps Other open while its box is still empty, and closes it on an alias', () => {
    expect(claudeMenu(listed, '', true)).toMatchObject({ selected: OTHER_MODEL, other: true })
    expect(claudeMenu(listed, 'sonnet', true)).toMatchObject({ selected: 'sonnet', other: false })
  })

  it('takes a new alias --help names, and has a menu before --help is read', () => {
    expect(claudeMenu(claudeModels(['mythos', 'opus']), '').models.map((m) => m.value)).toEqual(['', 'mythos', 'opus', 'haiku', OTHER_MODEL])
    expect(claudeMenu(undefined, '').models).toHaveLength(6)
  })
})
