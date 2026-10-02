import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openApprovals } from '../server/threads/status.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startServer, type RunningServer } from '../server/start.ts'
import { createCockpitApi, createCockpitMcpServer } from '../server/mcp/tools.ts'
import type { EventSink } from '../server/agents/types.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
let server: RunningServer | undefined
let client: Client | undefined
let mcp: ReturnType<typeof createCockpitMcpServer> | undefined
afterEach(async () => { await client?.close(); await mcp?.close(); await server?.close() })
const text = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join('')
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-conversations-'))
  let token = ''
  let emit: EventSink = () => {}
  server = await startServer({ port: 0, stateRoot: root, webDist: root, agentProbe: async () => ({ installed: true, version: 'fixture' }), mcp: { command: process.execPath, args: [] }, launchers: {
    claude: (req, sink) => { token = req.cockpit!.secretEnv.COCKPIT_MCP_TOKEN!; emit = sink; return {
      agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {}, close: async () => sink({ kind: 'exit', code: 0 }),
    } },
  } })
  const caller = server.manager.create({ projectPath: root, settings: threadSettingsSchema.parse({}), text: 'source' })
  const add = (title: string, projectPath = root) => server!.store.create({ ...caller, id: randomUUID(), title, projectPath, instructionsText: 'CONFIG-SECRET', sessionId: 'SESSION-SECRET' })
  const target = add('Peer')
  const foreign = add('PRIVATE PROJECT', root + '/other')
  const [a, b] = InMemoryTransport.createLinkedPair()
  mcp = createCockpitMcpServer(createCockpitApi(server.url, token)); await mcp.connect(b)
  client = new Client({ name: 'test', version: '1' }); await client.connect(a)
  return { caller, target, foreign, emit: (e: Parameters<EventSink>[0]) => emit(e), token }
}
it('lists only same-project conversations, pages stably and reads via actual SDK tools', async () => {
  const { caller, target, foreign } = await setup()
  const first = JSON.parse(text(await client!.callTool({ name: 'list_conversations', arguments: { limit: 1 } })))
  expect(first.callerId).toBe(caller.id); expect(first.conversations).toHaveLength(1)
  const next = JSON.parse(text(await client!.callTool({ name: 'list_conversations', arguments: { limit: 1, cursor: first.next } })))
  expect(new Set([...first.conversations, ...next.conversations].map((t) => t.id))).toEqual(new Set([caller.id, target.id]))
  expect(next.next).toBeUndefined()
  server!.store.append(target.id, { kind: 'assistant_text', messageId: 'm', text: 'Useful peer result' })
  const read = text(await client!.callTool({ name: 'read_conversation', arguments: { id: target.id } }))
  expect(read).toContain('Useful peer result'); expect(read).not.toMatch(/CONFIG-SECRET|SESSION-SECRET/)
  const denied = await client!.callTool({ name: 'read_conversation', arguments: { id: foreign.id } })
  expect(denied.isError).toBe(true); expect(text(denied)).not.toContain('PRIVATE PROJECT')
})
it('bounds Unicode output, advances cursors and exposes current streamed/approval state', async () => {
  const { caller, emit } = await setup()
  for (let i = 0; i < 50; i++) server!.store.append(caller.id, { kind: 'assistant_text', messageId: String(i), text: '界'.repeat(5000) })
  emit({ kind: 'text_delta', text: 'still working' })
  emit({ kind: 'approval_request', requestId: 'p', toolName: 'Bash', input: { secret: 'NO-RAW-INPUT' }, suggestions: [] })
  const raw = text(await client!.callTool({ name: 'read_conversation', arguments: { id: caller.id, since: 0, limit: 100 } }))
  expect(Buffer.byteLength(raw)).toBeLessThan(32_000)
  const read = JSON.parse(raw); expect(read.more).toBe(true); expect(read.streaming).toBe('still working'); expect(read.conversation.status).toBe('needs_input')
  const next = JSON.parse(text(await client!.callTool({ name: 'read_conversation', arguments: { id: caller.id, since: read.next } })))
  expect(next.events[0].index).toBe(read.next)
  expect(text(await client!.callTool({ name: 'read_conversation', arguments: { id: caller.id, limit: 1 } }))).not.toContain('NO-RAW-INPUT')
})
it('rejects bad bounds, foreign cursors, deleted callers and revoked grants', async () => {
  const { caller, foreign, emit, token } = await setup()
  for (const path of ['/conversations?limit=0', '/conversations?limit=1.5', '/conversations?limit=51', `/conversations/${caller.id}?since=-1`, `/conversations?cursor=${foreign.id}`]) {
    const r = await fetch(server!.url + '/api/mcp' + path, { headers: { authorization: `Bearer ${token}` } }); expect(r.status).toBe(400)
  }
  server!.store.remove(caller.id)
  expect((await client!.callTool({ name: 'list_conversations', arguments: {} })).isError).toBe(true)
  server!.store.create(caller) // Restore after the missing-caller check, then exercise normal session revocation.
  emit({ kind: 'exit', code: 0 })
  expect(text(await client!.callTool({ name: 'list_conversations', arguments: {} }))).toContain('session token')
})
it('gates SDK mutations at the host and cancels disconnected HTTP actions', async () => {
  const { caller, token } = await setup()
  const args = { agent: 'claude', text: 'Review the README', request_key: 'sdk' }
  const result = client!.callTool({ name: 'start_conversation', arguments: args })
  await vi.waitFor(() => expect(openApprovals(server!.store.events(caller.id))).toHaveLength(1))
  expect(server!.store.list()).toHaveLength(3)
  server!.manager.approve(caller.id, openApprovals(server!.store.events(caller.id))[0]!, 'allow')
  const child = JSON.parse(text(await result))
  expect(server!.store.get(child.id)).toMatchObject({ createdByThreadId: caller.id })
  expect(JSON.parse(text(await client!.callTool({ name: 'start_conversation', arguments: args })))).toEqual(child)
  const post = (body: unknown, auth = token, signal?: AbortSignal) => fetch(server!.url + '/api/mcp/conversations/start', {
    method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  expect((await post(args, 'invalid')).status).toBe(401)
  expect((await post({ ...args, request_key: 'invalid-fields', permissions: 'auto' })).status).toBe(400)
  const abort = new AbortController()
  const disconnected = post({ ...args, request_key: 'disconnect' }, token, abort.signal).catch((e: Error) => e.name)
  await vi.waitFor(() => expect(openApprovals(server!.store.events(caller.id))).toHaveLength(1))
  abort.abort(); expect(await disconnected).toBe('AbortError')
  await vi.waitFor(() => expect(openApprovals(server!.store.events(caller.id))).toHaveLength(0))
  expect(server!.store.list()).toHaveLength(4)
})
