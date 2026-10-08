import { describe, expect, it } from 'vitest'
import { modelChoices } from '../web/src/model-choices.ts'

const listed = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'gpt-oss-120b-medium' },
]

describe('the Model choices for an agent that lists its own models (Antigravity)', () => {
  it('offers the default and every listed model by name, whatever is chosen now', () => {
    const choices = modelChoices(listed, 'gemini-3.1-pro-low')
    expect(choices).toEqual([
      { value: '', label: 'Default model' },
      { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
      { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { value: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' },
    ])
  })

  it('keeps a remembered model the agent no longer lists, marked, so the choice is not silently lost', () => {
    const choices = modelChoices(listed, 'gemini-3.6-flash-low')
    expect(choices.at(-1)).toEqual({ value: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low (not listed now)' })
    expect(choices).toHaveLength(listed.length + 2)
  })
})
