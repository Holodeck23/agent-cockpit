import { expect, it } from 'vitest'
import { assessClaudeInstructions } from '../scripts/lib/w13-claude-instruction-oracle.ts'

const words = ['root', 'import', 'nested', 'shared'].map((label) => label + '-a'.repeat(24))
const excluded = 'sibling-' + 'b'.repeat(32), prompt = 'Reply with the four synthetic instruction words.'
const rootShared = 'root-shared-' + 'c'.repeat(32)
const sources = [{ file: '/owned/CLAUDE.md' }, { file: '/owned/import.md', parent: '/owned/CLAUDE.md' },
  { file: '/owned/nested/CLAUDE.md' }]
const events = sources.map((source) => ({ hook_event_name: 'InstructionsLoaded', session_id: 'session',
  file_path: source.file, memory_type: 'Project', load_reason: source.parent ? 'include' : 'session_start',
  parent_file_path: source.parent }))
const done = { session_id: 'session', subtype: 'success', is_error: false, result: words.join('\n') }
const assess = (result = done, loaded = events, output = '') =>
  assessClaudeInstructions(result, 'session', sources, loaded, words, rootShared, excluded, prompt, output)
it('requires native root/import/nested provenance as well as exact behavioral selection', () => {
  expect(assess()).toMatchObject({ expectedNativeSourcesObserved: 3, sharedSelection: 'NESTED_VALUE_REPORTED', deterministicCollisionPrecedenceEstablished: false })
  expect(() => assess(done, events.slice(1))).toThrow()
  expect(() => assess(done, events, excluded)).toThrow()
})
it.each([{ session_id: 'other' }, { memory_type: 'User' }, { hook_event_name: 'other' },
  { load_reason: 'compact' }, { file_path: '/unselected/import.md' }, { parent_file_path: '/other/CLAUDE.md' }])(
  'rejects substituted native import provenance %j', (change) => {
    expect(() => assess(done, events.map((event, index) => index === 1 ? { ...event, ...change } : event))).toThrow()
  })
it.each([{ session_id: 'other' }, { subtype: 'error' }, { is_error: true }, { result: 'UNKNOWN' },
  { result: [...words.slice(0, 3), 'UNKNOWN'].join('\n') }, { result: [...words, words[3]].join('\n') }])(
  'rejects wrong result binding or precedence %j', (change) => {
    expect(() => assess({ ...done, ...change })).toThrow()
  })
it('cannot pass from prompt-injected words or missing native events', () => {
  expect(() => assessClaudeInstructions(done, 'session', sources, events, words, rootShared, excluded, words[0]!, '')).toThrow()
  expect(() => assess(done, [])).toThrow()
})
it('retains a root selection or both conflicting values without claiming deterministic override', () => {
  expect(assess({ ...done, result: [...words.slice(0, 3), rootShared].join('\n') })).toMatchObject({ sharedSelection: 'ROOT_VALUE_REPORTED', deterministicCollisionPrecedenceEstablished: false })
  expect(assess({ ...done, result: [...words.slice(0, 3), rootShared, words[3]].join('\n') })).toMatchObject({ sharedSelection: 'CONFLICT_BOTH_REPORTED', deterministicCollisionPrecedenceEstablished: false })
})

it('requires both project rule words and their native loaded-source events', () => {
  const ruleWords = ['root-rule-', 'nested-rule-'].map((name) => name + 'd'.repeat(32))
  const ruleSources = [...sources, { file: '/owned/.claude/rules/test.md' }, { file: '/owned/nested/.claude/rules/test.md' }]
  const ruleEvents = [...events, ...ruleSources.slice(3).map((source) => ({ ...events[0], file_path: source.file }))]
  const result = { ...done, result: [...words.slice(0, 3), ...ruleWords, words[3]].join('\n') }
  const assessRules = (loaded = ruleEvents, answer = result) => assessClaudeInstructions(answer, 'session', ruleSources,
    loaded, [...words, ...ruleWords], rootShared, excluded, prompt, '')
  expect(assessRules()).toMatchObject({ expectedNativeSourcesObserved: 5, projectRuleWordsMatched: true,
    deterministicCollisionPrecedenceEstablished: false })
  expect(() => assessRules(ruleEvents.slice(0, -1))).toThrow()
  expect(() => assessRules(ruleEvents, { ...result, result: words.join('\n') })).toThrow()
  expect(() => assessRules(ruleEvents.map((event, index) => index === 4 ? { ...event, memory_type: 'User' } : event))).toThrow()
})
