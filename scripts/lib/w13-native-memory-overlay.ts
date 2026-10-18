import assert from 'node:assert/strict'

/** Select one native schema, never an unrelated same-name MCP tool. */
export function nativeMemoryCall(tools: any, name: 'read' | 'add_ad_hoc_note', callId: string, args: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(tools), 'Native tool inventory absent')
  const candidates: { name: string; namespace?: string; schema: any }[] = []
  for (const tool of tools) {
    if (tool?.type === 'namespace' && tool.name === 'memories' && Array.isArray(tool.tools)) {
      for (const child of tool.tools) if (child?.type === 'function' && child.name === name) {
        candidates.push({ name, namespace: 'memories', schema: child.parameters })
      }
    } else if (tool?.type === 'function' && tool.name === `memories__${name}`) {
      candidates.push({ name: tool.name, schema: tool.parameters })
    }
  }
  assert.equal(candidates.length, 1, 'Required native memory tool missing or ambiguous')
  const selected = candidates[0]!
  for (const property of name === 'read' ? ['path'] : ['filename', 'note']) assert.ok(selected.schema?.properties?.[property])
  return { type: 'function_call', id: `${callId}-item`, call_id: callId, name: selected.name,
    ...(selected.namespace ? { namespace: selected.namespace } : {}), arguments: JSON.stringify(args) }
}

/** Inspect the actual native tool result, not an echoed call argument or final assistant text. */
export function nativeMemoryResult(request: any, callId: string, expectedContent?: string): void {
  assert.ok(Array.isArray(request?.input))
  const results = request.input.filter((item: any) => item?.type === 'function_call_output' && item.call_id === callId)
  assert.equal(results.length, 1, 'Native memory result missing, replayed or wrongly bound')
  assert.ok(results[0].output !== undefined)
  if (expectedContent) assert.ok(JSON.stringify(results[0].output).includes(expectedContent), 'Native read did not return the persisted note')
}
