// Packaged scope proof, using real stdio SDK tools and a fixture-owned session token.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject, startConversation, headStatus } from './lib/ui.ts'
const root = mkdtempSync(join(tmpdir(), 'cockpit-read-proof-'))
const project = join(root, 'project'); mkdirSync(project)
const store = createThreadStore(join(root, 'state'))
const add = (title: string, projectPath: string) => {
  const ts = new Date().toISOString()
  return store.create({ id: randomUUID(), title, projectPath, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed: false, createdAt: ts, updatedAt: ts })
}
const peer = add('Peer result', project)
store.append(peer.id, { kind: 'assistant_text', messageId: 'peer', text: 'The startup command is npm run dev.' })
const foreign = add('Other project secret', root)
const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/conversation-reader') })
const client = new Client({ name: 'packaged-proof', version: '1' })
try {
  const page = await app.firstWindow()
  await openProject(page, project)
  await startConversation(page, 'Read peer context')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  const binary = await app.evaluate(() => process.execPath)
  const bundle = await app.evaluate(({ app }) => app.getAppPath())
  await client.connect(new StdioClientTransport({ command: binary, args: [join(bundle, 'dist-electron/mcp.cjs')], env: {
    ELECTRON_RUN_AS_NODE: '1', COCKPIT_MCP_TOKEN: readFileSync(join(project, '.reader-token'), 'utf8'), COCKPIT_MCP_URL: readFileSync(join(project, '.reader-url'), 'utf8'),
  } }))
  const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('')
  const listed = text(await client.callTool({ name: 'list_conversations', arguments: {} }))
  assert.match(listed, /Peer result/); assert.doesNotMatch(listed, /Other project secret/)
  console.log('PASS real packaged stdio SDK tool lists same-project conversations only')
  assert.match(text(await client.callTool({ name: 'read_conversation', arguments: { id: peer.id } })), /npm run dev/)
  console.log('PASS reads the peer result')
  assert.equal((await client.callTool({ name: 'read_conversation', arguments: { id: foreign.id } })).isError, true)
  console.log('PASS refuses foreign conversation')
  await page.locator('.card').filter({ hasText: 'Peer result' }).click()
  await page.getByText('The startup command is npm run dev.', { exact: true }).waitFor()
  mkdirSync(PROOF_DIR, { recursive: true })
  await page.screenshot({ path: join(PROOF_DIR, 'mcp-conversation-read.png') })
  writeFileSync(join(PROOF_DIR, 'mcp-conversation-read-result.json'), JSON.stringify(JSON.parse(listed), null, 2))
  console.log('PROOF CONVERSATION READ PASS (3 checks; no provider usage)')
} finally { await client.close(); await app.close() }
