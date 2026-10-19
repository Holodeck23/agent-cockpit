import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'

/** Snapshot original memory without following links or reading any credential file. */
export function nativeMemorySnapshot(root: string, prefix = '', depth = 0): Record<string, string> {
  assert.ok(depth <= 12)
  const file = join(root, prefix)
  let stat
  try { stat = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { [prefix]: 'absent' }
    throw error
  }
  if (stat.isSymbolicLink()) return { [prefix]: `untraversed-symlink:${readlinkSync(file)}` }
  if (stat.isFile()) return { [prefix]: createHash('sha256').update(readFileSync(file)).digest('hex') }
  assert.ok(stat.isDirectory())
  const entries = readdirSync(file); assert.ok(entries.length <= 4096)
  return Object.assign({ [prefix + '/']: 'directory' }, ...entries.map((name) => nativeMemorySnapshot(root, join(prefix, name), depth + 1)))
}

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

/** Bind live native raw items to their protocol thread/turn and exact memory call/result. */
export function nativeMemoryProgram(phase: 'write' | 'read', filename: string, note: string): string {
  assert.ok(/^[a-zA-Z0-9_.:-]+\.md$/.test(filename))
  const name = phase === 'write' ? 'add_ad_hoc_note' : 'read'
  const args = phase === 'write' ? { filename, note } : { path: `extensions/ad_hoc/notes/${filename}`, line_offset: 1, max_lines: 10 }
  return `text({w13NativeMemoryResult: await tools.memories__${name}(${JSON.stringify(args)})})`
}

export function nativeMemoryTrace(events: any[], threadId: string, turnId: string, phase: 'write' | 'read',
  filename: string, note: string): { callId: string; itemCount: number; route: 'direct' | 'approved-code-mode-program' } {
  assert.ok(threadId && turnId && events.length > 0 && events.length <= 256)
  for (const event of events) assert.ok(event.threadId === threadId && event.turnId === turnId && event.item && typeof event.item === 'object')
  const items = events.map((event) => event.item)
  const calls = items.filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
  assert.equal(calls.length, 1, 'Live probe requires exactly one native memory call')
  const call = calls[0], name = phase === 'write' ? 'add_ad_hoc_note' : 'read'
  assert.ok(typeof call.call_id === 'string' && call.call_id.length > 0)
  if (phase === 'read') assert.ok(!JSON.stringify(items.slice(0, items.indexOf(call))).includes(note), 'Persisted note reached fresh context before native read')
  if (call.type === 'custom_tool_call' && call.name === 'exec' && !call.namespace) {
    assert.equal(call.input?.trim().replace(/;$/, ''), nativeMemoryProgram(phase, filename, note), 'Only the exact source-owned memory program is allowed')
    const outputs = items.filter((item) => item.type === 'custom_tool_call_output' && item.call_id === call.call_id)
    assert.equal(outputs.length, 1, 'Native execution result missing or unbound')
    const result = JSON.stringify(outputs[0].output)
    assert.ok(result.includes('w13NativeMemoryResult'), 'Approved native memory program did not return its tagged result')
    if (phase === 'read') assert.ok(result.includes(note), 'Native code-mode read did not return the persisted note')
    return { callId: call.call_id, itemCount: items.length, route: 'approved-code-mode-program' }
  }
  assert.ok(call.type === 'function_call' && ((call.namespace === 'memories' && call.name === name) || (!call.namespace && call.name === `memories__${name}`)), 'Unexpected live native tool')
  const args = JSON.parse(call.arguments)
  if (phase === 'write') { assert.equal(args.filename, filename); assert.equal(args.note, note) }
  else {
    assert.equal(args.path, `extensions/ad_hoc/notes/${filename}`)
  }
  nativeMemoryResult({ input: items }, call.call_id, phase === 'read' ? note : undefined)
  return { callId: call.call_id, itemCount: items.length, route: 'direct' }
}
