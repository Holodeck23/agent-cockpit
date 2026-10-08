import { describe, expect, it } from 'vitest'
import { groupAgyModels, locateAgyModel, resolveAgyModel } from '../server/agents/antigravity/models.ts'

// `agy models` on 1.3.1 (10-08), abridged: one id per model and effort, labelled "Name (Effort)".
const LISTED = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  { id: 'some-new-model' },
]

describe('agy models as Antigravity shows them: a model, then its effort', () => {
  it('groups the ids into models by name, each with the efforts it offers, low to high', () => {
    expect(groupAgyModels(LISTED)).toEqual([
      { base: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', levels: ['low', 'medium', 'high'] },
      { base: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', levels: ['low', 'high'] },
      { base: 'claude-opus-5-5', label: 'Claude Opus 5.5', levels: ['low', 'medium', 'high'] },
      { base: 'gpt-oss-120b', label: 'GPT-OSS 120B', levels: ['medium'] },
      { base: 'some-new-model', label: 'some-new-model', levels: [] },
    ])
  })

  it('finds a model chosen by name or by one of its ids (a choice remembered before the grouping)', () => {
    const groups = groupAgyModels(LISTED)
    expect(locateAgyModel(groups, 'gemini-3.1-pro')).toMatchObject({ group: { base: 'gemini-3.1-pro' } })
    expect(locateAgyModel(groups, 'gemini-3.1-pro-low')).toMatchObject({ group: { base: 'gemini-3.1-pro' }, level: 'low' })
    expect(locateAgyModel(groups, 'gemini-9')).toBeUndefined()
  })
})

describe('the one id a launch sends to agy (1.3.1 refuses an id plus a different --effort, and a name without one)', () => {
  it('joins the model and its effort into the id agy lists', () => {
    expect(resolveAgyModel('gemini-3.1-pro', 'low', LISTED)).toEqual({ id: 'gemini-3.1-pro-low' })
    expect(resolveAgyModel('claude-opus-5-5', 'max', LISTED)).toEqual({ id: 'claude-opus-5-5-high' })
  })

  it('without an effort: the model\'s own for a remembered id, else Medium, else its highest', () => {
    expect(resolveAgyModel('gemini-3.8-flash-low', undefined, LISTED)).toEqual({ id: 'gemini-3.8-flash-low' })
    expect(resolveAgyModel('gemini-3.8-flash', undefined, LISTED)).toEqual({ id: 'gemini-3.8-flash-medium' })
    expect(resolveAgyModel('gemini-3.1-pro', undefined, LISTED)).toEqual({ id: 'gemini-3.1-pro-high' })
  })

  it('an effort changed after choosing an id moves to that effort of the same model', () => {
    expect(resolveAgyModel('gemini-3.8-flash-low', 'high', LISTED)).toEqual({ id: 'gemini-3.8-flash-high' })
  })

  it('refuses an effort the model does not offer, naming the ones it does', () => {
    expect(resolveAgyModel('gemini-3.1-pro', 'medium', LISTED)).toEqual({ refused: expect.stringMatching(/Gemini 3\.1 Pro offers Low or High effort, not Medium/) })
    expect(resolveAgyModel('gemini-9', undefined, LISTED)).toEqual({ refused: expect.stringMatching(/does not offer the model gemini-9/) })
  })

  it('sends a model with no effort variants as listed', () => {
    expect(resolveAgyModel('some-new-model', 'high', LISTED)).toEqual({ id: 'some-new-model' })
  })
})
