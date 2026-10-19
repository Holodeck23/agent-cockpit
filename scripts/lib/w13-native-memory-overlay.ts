import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'

/** Empty tables merge with native MCP settings. Disable every resolved name explicitly. */
export function isolatedMemoryThreadConfig(response: any): { config: Record<string, unknown>; sourceFiles: string[] } {
  assert.ok(response?.config && typeof response.config === 'object' && !Array.isArray(response.config), 'Native effective config absent')
  assert.equal(response.config.mcpServers, undefined, 'Unexpected native MCP config spelling')
  const servers = response.config.mcp_servers ?? {}
  assert.ok(servers && typeof servers === 'object' && !Array.isArray(servers))
  const names = Object.keys(servers)
  assert.ok(names.length <= 64 && names.every((name) => name.length > 0 && name.length <= 256))
  for (const name of names) assert.ok(servers[name] && typeof servers[name] === 'object' && !Array.isArray(servers[name]))
  assert.ok(Array.isArray(response.layers) && response.layers.length > 0 && response.layers.length <= 64, 'Native config layers absent or unbounded')
  const files = new Set<string>()
  let sessionFlagsObserved = false
  for (const layer of response.layers) {
    const source = layer?.name
    if (source?.type === 'sessionFlags') { sessionFlagsObserved = true; continue }
    let file: unknown
    if (['packagedDefaults', 'system', 'user', 'legacyManagedConfigTomlFromFile'].includes(source?.type)) file = source.file
    else if (source?.type === 'project') {
      const folder = source.dot_codex_folder ?? source.dotCodexFolder
      assert.ok(typeof folder === 'string' && isAbsolute(folder)); file = join(folder, 'config.toml')
    } else assert.fail('Dynamic or unknown config source is outside this controlled probe')
    assert.ok(typeof file === 'string' && isAbsolute(file) && file.endsWith('.toml'), 'Unexpected native config source file')
    files.add(file)
  }
  assert.ok(sessionFlagsObserved, 'Native CLI override layer absent')
  return { config: { mcp_servers: Object.fromEntries(names.map((name) => [name, { enabled: false }])) }, sourceFiles: [...files] }
}

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
