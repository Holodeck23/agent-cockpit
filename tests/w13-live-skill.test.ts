import { expect, it } from 'vitest'
import { nativeSkillProgram, nativeSkillTrace } from '../scripts/lib/w13-live-skill.ts'

const expected = { selectedDir: '/fixture/selected', selected: 'SELECTED-' + 'a'.repeat(32), excluded: 'EXCLUDED-' + 'b'.repeat(32),
  resource: 'RESOURCE-' + 'c'.repeat(32), args: '  --label "two  words"\n--target fixture  ' }
const items = () => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: expected.selected }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: expected.args }] },
  { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: nativeSkillProgram(expected.selectedDir) },
  { type: 'custom_tool_call_output', call_id: 'call', output: { w13NativeSkillResource: { output: expected.resource } } },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({ selected: expected.selected, arguments: expected.args, resource: expected.resource }) }] },
]
const trace = (values: any[]) => nativeSkillTrace(values.map((item) => ({ threadId: 'thread', turnId: 'turn', item })), 'thread', 'turn', expected)
it('requires exact selected skill behavior and independently returned native resource', () => {
  expect(trace(items())).toEqual({ itemCount: 5, callId: 'call' })
})
it.each(['call', 'output', 'final'])('rejects missing %s even if the final answer contains the expected values', (part) => {
  expect(() => trace(items().filter((_item, index) => index !== 2 + ['call', 'output', 'final'].indexOf(part)))).toThrow()
})
it.each(['path', 'program', 'callId', 'duplicate', 'canary', 'arguments', 'early', 'thread', 'turn'])('rejects altered %s evidence', (part) => {
  const values: any[] = items()
  if (part === 'path') values[2].input = nativeSkillProgram('/fixture/other')
  if (part === 'program') values[2].input += '\ntext("extra")'
  if (part === 'callId') values[3].call_id = 'other'
  if (part === 'duplicate') values.push(values[3])
  if (part === 'canary') values.push({ type: 'message', content: expected.excluded })
  if (part === 'arguments') values[4].content[0].text = values[4].content[0].text.replace('two  words', 'two words')
  if (part === 'early') values.unshift({ type: 'message', content: expected.resource })
  if (part === 'thread' || part === 'turn') {
    const events = values.map((item) => ({ threadId: part === 'thread' ? 'other' : 'thread', turnId: part === 'turn' ? 'other' : 'turn', item }))
    expect(() => nativeSkillTrace(events, 'thread', 'turn', expected)).toThrow(); return
  }
  expect(() => trace(values)).toThrow()
})
it.each(['source', 'inputArgs', 'metadata', 'attachedResource'])('rejects missing or contaminated native input: %s', (part) => {
  const values: any[] = items()
  if (part === 'source') values[0].content[0].text = 'missing source'
  if (part === 'inputArgs') values[1].content[0].text = expected.args.trim()
  if (part === 'metadata') { values[0].metadata = expected.selected; values[0].content[0].text = 'metadata only' }
  if (part === 'attachedResource') values[0].content[0].text += expected.resource
  expect(() => trace(values)).toThrow()
})
