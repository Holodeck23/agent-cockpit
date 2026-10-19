import { expect, it } from 'vitest'
import { linkedSkillTemplate, nativeLinkedSkillTrace } from '../scripts/lib/w13-linked-skill.ts'
import { nativeSkillProgram } from '../scripts/lib/w13-live-skill.ts'

const expected = { selectedDir: '/fixture/canonical/selected', discoveryFile: '/fixture/discovery/selected/SKILL.md',
  selected: 'SELECTED-' + 'a'.repeat(32), excluded: 'EXCLUDED-' + 'b'.repeat(32), resource: 'RESOURCE-' + 'c'.repeat(32), args: '  --label "two  words"\n--target fixture  ' }
const items = () => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<skill>\n<name>fixture</name>\n<path>${expected.selectedDir}/SKILL.md</path>\n${expected.selected}\n${linkedSkillTemplate()}\n</skill>` }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: expected.args }] },
  { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: nativeSkillProgram(expected.selectedDir) },
  { type: 'custom_tool_call_output', call_id: 'call', output: [{ type: 'input_text', text: JSON.stringify({ w13NativeSkillResource: { exit_code: 0, output: expected.resource } }) }] },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({ selected: expected.selected, arguments: expected.args, resource: expected.resource }) }] },
]
const trace = (values: any[]) => nativeLinkedSkillTrace(values.map((item) => ({ threadId: 'thread', turnId: 'turn', item })), 'thread', 'turn', expected)
it('observes canonical native identity and successful relative resource read from an alias selection', () => {
  expect(trace(items())).toEqual({ itemCount: 5, callId: 'call' })
})
it.each(['aliasWrapper', 'missingWrapper', 'missingTemplate', 'failedRead', 'looseText', 'changedBytes', 'duplicateTag'])('rejects invalid linked provenance: %s', (part) => {
  const values: any[] = items()
  if (part === 'aliasWrapper') values[0].content[0].text = values[0].content[0].text.replace(`${expected.selectedDir}/SKILL.md`, expected.discoveryFile)
  if (part === 'missingWrapper') values[0].content[0].text = expected.selected
  if (part === 'missingTemplate') values[0].content[0].text = values[0].content[0].text.replace(linkedSkillTemplate(), '')
  if (part === 'failedRead') values[3].output[0].text = JSON.stringify({ w13NativeSkillResource: { exit_code: 1, output: expected.resource } })
  if (part === 'looseText') values[3].output = [{ type: 'input_text', text: `w13NativeSkillResource ${expected.resource}` }]
  if (part === 'changedBytes') values[3].output[0].text = JSON.stringify({ w13NativeSkillResource: { exit_code: 0, output: expected.resource + '\n' } })
  if (part === 'duplicateTag') values[3].output.push(values[3].output[0])
  expect(() => trace(values)).toThrow()
})
