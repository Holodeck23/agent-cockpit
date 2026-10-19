import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { nativeSkillProgram, nativeSkillTrace } from './w13-live-skill.ts'

/** Resolve this placeholder from the native injected path, not a host-supplied resource root. */
export const linkedSkillTemplate = (): string => nativeSkillProgram('/W13_NATIVE_SKILL_DIRECTORY')

export function nativeLinkedSkillTrace(events: any[], threadId: string, turnId: string,
  expected: { selectedDir: string; selected: string; excluded: string; resource: string; args: string; discoveryFile: string }): { itemCount: number; callId: string } {
  assert.ok(isAbsolute(expected.discoveryFile) && expected.discoveryFile !== `${expected.selectedDir}/SKILL.md`)
  const result = nativeSkillTrace(events, threadId, turnId, expected)
  const items = events.map((event) => event.item)
  const callIndex = items.findIndex((item) => item.type === 'custom_tool_call' && item.call_id === result.callId)
  const skillBlocks = items.slice(0, callIndex).filter((item) => item.type === 'message' && item.role === 'user')
    .flatMap((item) => item.content ?? []).filter((block) => block.type === 'input_text' && typeof block.text === 'string'
      && block.text.startsWith('<skill>') && block.text.includes(expected.selected))
  assert.equal(skillBlocks.length, 1, 'Unique native selected-skill wrapper required')
  const block = skillBlocks[0].text
  assert.ok(block.includes(`\n<path>${expected.selectedDir}/SKILL.md</path>\n`), 'Native injection did not bind canonical skill identity')
  assert.ok(!block.includes(expected.discoveryFile), 'Native wrapper used the discovery alias instead of canonical identity')
  assert.ok(block.includes(linkedSkillTemplate()), 'Selected body lacks the root-independent resource template')
  const output = items.find((item) => item.type === 'custom_tool_call_output' && item.call_id === result.callId).output
  assert.ok(Array.isArray(output))
  const tagged = output.filter((part) => part.type === 'input_text' && typeof part.text === 'string'
    && part.text.startsWith('{"w13NativeSkillResource":')).map((part) => JSON.parse(part.text).w13NativeSkillResource)
  assert.equal(tagged.length, 1, 'Unique structured native resource result required')
  assert.equal(tagged[0].exit_code, 0, 'Resource read failed')
  assert.equal(tagged[0].output, expected.resource, 'Native output differs from exact selected resource bytes')
  return result
}
