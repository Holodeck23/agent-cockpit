import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'

/** A native initialize response must expose the exact command before any model input. */
export function requireNativeSkillCommand(commands: unknown, expected: string): void {
  assert.ok(typeof expected === 'string' && expected.length > 0)
  assert.ok(Array.isArray(commands), 'Native command inventory is missing')
  assert.equal(commands.filter((command) => command?.name === expected).length, 1,
    'Selected native skill command is missing or ambiguous')
}

/** Actual native Read/result linkage, separate from the model's final text assertion. */
export class ClaudeSkillResourceOracle {
  private reads = new Set<string>()
  private results = new Set<string>()
  policyAdmissions = 0
  constructor(readonly sessionId: string, readonly resourcePath: string, readonly marker: string,
    readonly resource: string, readonly excluded: string, readonly args: string) {
    assert.ok([marker, resource, excluded].every((value) => value.length >= 24))
    assert.equal(new Set([marker, resource, excluded]).size, 3)
    assert.ok(!args.includes(marker) && !args.includes(resource) && !args.includes(excluded))
  }
  permits(toolName: unknown, input: any): boolean {
    return toolName === 'Read' && typeof input?.file_path === 'string'
      && isAbsolute(input.file_path) && resolve(input.file_path) === this.resourcePath
  }
  record(message: any): void {
    if (!['assistant', 'user'].includes(message.type)) return
    for (const block of message.message?.content ?? []) {
      if (!['tool_use', 'tool_result'].includes(block.type)) continue
      assert.equal(message.session_id, this.sessionId)
      assert.ok(!message.parent_tool_use_id, 'Unexpected subagent event')
      if (block.type === 'tool_use') {
        assert.ok(this.permits(block.name, block.input), 'Native tool escaped selected resource')
        assert.ok(typeof block.id === 'string' && block.id.length > 0)
        this.reads.add(block.id)
      } else {
        assert.ok(this.reads.has(block.tool_use_id), 'Resource result has no matching native Read')
        assert.notEqual(block.is_error, true)
        assert.ok(JSON.stringify(block.content).includes(this.resource), 'Resource marker absent from actual native tool result')
        this.results.add(block.tool_use_id)
      }
    }
  }
  complete(message: any, nativeOutput: string): Record<string, unknown> {
    assert.equal(message.session_id, this.sessionId); assert.equal(message.subtype, 'success'); assert.equal(message.is_error, false)
    assert.equal(this.reads.size, 1); assert.equal(this.results.size, 1); assert.ok(this.policyAdmissions >= 1)
    assert.equal(typeof message.result, 'string')
    assert.equal(message.result.trim(), `${this.marker}\n${this.resource}\n${this.args}`)
    assert.ok(!nativeOutput.includes(this.excluded), 'Unselected source marker leaked')
    return { nativeReadResults: 1, selectedSourceMatched: true, resourceRead: true, argumentsPreserved: true,
      excludedAbsent: true, preToolPathPolicyObserved: true }
  }
}
