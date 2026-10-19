import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { assessNativeSkillRequest } from './w13-skill-request.ts'

/** Source-owned read program lives in the selected skill, never in the user input. */
export function nativeSkillProgram(selectedDir: string): string {
  assert.ok(isAbsolute(selectedDir))
  return `text({w13NativeSkillResource: await tools.exec_command(${JSON.stringify({ cmd: '/bin/cat reference.txt', workdir: selectedDir, login: false, max_output_tokens: 500 })})})`
}

/** Behavioral evidence plus an actual bound native resource result; model self-report alone fails. */
export function nativeSkillTrace(events: any[], threadId: string, turnId: string,
  expected: { selectedDir: string; selected: string; excluded: string; resource: string; args: string }): { itemCount: number; callId: string } {
  assert.ok(threadId && turnId && events.length > 0 && events.length <= 256)
  for (const event of events) assert.ok(event.threadId === threadId && event.turnId === turnId && event.item && typeof event.item === 'object')
  const items = events.map((event) => event.item)
  const calls = items.filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
  assert.equal(calls.length, 1, 'Exactly one native selected-resource call required')
  const call = calls[0]
  assert.ok(call.type === 'custom_tool_call' && call.name === 'exec' && !call.namespace && typeof call.call_id === 'string' && call.call_id)
  assert.equal(call.input?.trim().replace(/;$/, ''), nativeSkillProgram(expected.selectedDir), 'Unexpected program or resource path')
  const initial = items.slice(0, items.indexOf(call)).filter((item) => item.type === 'message' && item.role === 'user')
  const context = assessNativeSkillRequest({ input: initial }, expected.selected, expected.excluded, expected.args, expected.resource)
  assert.equal(context.resourceInContext, false, 'Resource was attached as context')
  assert.ok(!JSON.stringify(items.slice(0, items.indexOf(call) + 1)).includes(expected.resource), 'Resource leaked before the read')
  const outputs = items.filter((item) => item.type === 'custom_tool_call_output' && item.call_id === call.call_id)
  assert.equal(outputs.length, 1, 'Missing, duplicated or misbound native resource output')
  const output = JSON.stringify(outputs[0].output)
  assert.ok(output.includes('w13NativeSkillResource') && output.includes(expected.resource), 'Selected resource absent from native result')
  assert.ok(items.indexOf(outputs[0]) > items.indexOf(call), 'Result precedes call')
  assert.ok(!JSON.stringify(items).includes(expected.excluded), 'Excluded source canary exposed')
  const finals = items.filter((item) => item.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer')
  assert.equal(finals.length, 1, 'Unique final native assistant message required')
  const content = finals[0].content
  assert.ok(Array.isArray(content) && content.length === 1 && content[0].type === 'output_text')
  assert.deepEqual(JSON.parse(content[0].text), { selected: expected.selected, arguments: expected.args, resource: expected.resource },
    'Native selected skill behavior or exact argument bytes differ')
  return { itemCount: items.length, callId: call.call_id }
}
