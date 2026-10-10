// Real packaged stdio MCP and UI approvals; both provider protocols use synthetic fixtures.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createThreadStore } from '../server/threads/store.ts'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject, startConversation, headStatus, chooseAgent } from './lib/ui.ts'

const root = mkdtempSync(join(tmpdir(), 'cockpit-control-proof-'))
const project = join(root, 'project'); mkdirSync(project)
const store = createThreadStore(join(root, 'state'))
const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/conversation-controller') })
const clients: Client[] = []
const source = process.argv.includes('--codex') ? 'codex' : process.argv.includes('--opencode') ? 'opencode' : 'claude'
let checks = 0
let ids: { source: string; child: string } | undefined
const pass = (label: string) => { checks++; console.log(`PASS ${label}`) }
const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('')
try {
  const page = await app.firstWindow()
  await openProject(page, project)
  await chooseAgent(page, { agent: source })
  await startConversation(page, 'Coordinate a review')
  await page.getByText('Controller ready for an approved handoff.', { exact: true }).waitFor()
  const caller = store.list()[0]!
  const binary = await app.evaluate(() => process.execPath)
  const bundle = await app.evaluate(({ app }) => app.getAppPath())
  const connect = async (token: string) => {
    const client = new Client({ name: 'packaged-control-proof', version: '1' }); clients.push(client)
    await client.connect(new StdioClientTransport({ command: binary, args: [join(bundle, 'dist-electron/mcp.cjs')], env: {
      ELECTRON_RUN_AS_NODE: '1', COCKPIT_MCP_TOKEN: token, COCKPIT_MCP_URL: readFileSync(join(project, '.controller-url'), 'utf8'),
    } }))
    return client
  }
  const client = await connect(readFileSync(join(project, `.controller-${caller.sessionId}-token`), 'utf8'))
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  const args = { agent: 'codex', text: 'Review the README', title: 'Delegated review', request_key: 'denied' }
  const denied = call('start_conversation', args)
  const card = page.locator('.approval.open')
  await card.getByText(/Review the README/).waitFor()
  assert.equal(await card.getByRole('button', { name: 'Allow for this session' }).count(), 0)
  assert.equal(store.list().length, 1)
  await card.getByRole('button', { name: 'Deny', exact: true }).click()
  assert.equal((await denied).isError, true); assert.equal(store.list().length, 1)
  pass('denied action creates no child and offers no standing approval')

  const accepted = call('start_conversation', { ...args, request_key: 'allowed' })
  await card.getByText(/Review the README/).waitFor()
  mkdirSync(PROOF_DIR, { recursive: true })
  await page.screenshot({ path: join(PROOF_DIR, `mcp-control-${source}-approval.png`) })
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  const response = await accepted; assert.ok(!response.isError, text(response))
  const child = JSON.parse(text(response)) as { id: string; status: string }
  assert.equal(store.get(child.id)?.settings.agent, 'codex')
  assert.equal(store.get(child.id)?.settings.permissionMode, 'manual')
  await page.locator('.card').filter({ hasText: 'Delegated review' }).click()
  await page.getByText('The README review is complete.', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'From Coordinate a review' }).waitFor()
  await page.screenshot({ path: join(PROOF_DIR, `mcp-control-${source}-child.png`) })
  pass(`approved ${source}-to-Codex task launches with manual permissions and visible origin`)
  assert.match(text(await call('read_conversation', { id: child.id })), /README review is complete/)
  assert.equal(JSON.parse(text(await call('start_conversation', { ...args, request_key: 'allowed' }))).id, child.id)
  assert.equal(store.list().length, 2)
  pass('controller reads result and replay creates no duplicate')

  // The origin link must navigate back to the requesting conversation.
  await page.getByRole('link', { name: 'From Coordinate a review' }).click()
  await page.getByRole('heading', { name: 'Coordinate a review', exact: true }).waitFor()
  const follow = call('send_to_conversation', { id: child.id, text: 'KEEP_WORKING: check another detail', request_key: 'follow' })
  await card.getByText(/KEEP_WORKING/).waitFor()
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  assert.ok(!(await follow).isError)
  await page.locator('.card').filter({ hasText: 'Delegated review' }).click()
  await page.getByText('Working on the approved follow-up.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('link', { name: 'From Coordinate a review' }).count(), 2)
  await headStatus(page).filter({ hasText: 'Working' }).waitFor()
  assert.equal((await call('send_to_conversation', { id: child.id, text: 'Do not queue', request_key: 'busy' })).isError, true)
  pass('approved follow-up carries origin; busy target rejects a second send')
  const nested = await connect(readFileSync(join(project, '.child-token'), 'utf8'))
  const nestedResult = await nested.callTool({ name: 'start_conversation', arguments: { ...args, request_key: 'nested' } })
  assert.equal(nestedResult.isError, true); assert.match(text(nestedResult), /Delegated/)
  pass('delegated Codex caller cannot recursively launch an agent')

  await page.locator('.card').filter({ hasText: 'Coordinate a review' }).click()
  const stopped = call('stop_conversation', { id: child.id, request_key: 'stop' })
  await card.getByText(/Stop Delegated review/).waitFor()
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  assert.equal(JSON.parse(text(await stopped)).status, 'interrupt_requested')
  await page.locator('.card').filter({ hasText: 'Delegated review' }).click()
  await headStatus(page).filter({ hasText: 'Idle' }).waitFor()
  pass('approved stop interrupts the target through its normal provider adapter')
  await page.locator('.card').filter({ hasText: 'Coordinate a review' }).click()
  const canceled = call('start_conversation', { ...args, request_key: 'cancel' })
  await card.getByText(/Review the README/).waitFor()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  assert.equal((await canceled).isError, true)
  await headStatus(page).filter({ hasText: 'Idle' }).waitFor()
  assert.equal(store.list().length, 2)
  pass('stopping the controller cancels its pending action without launching a child')
  ids = { source: caller.id, child: child.id }
} finally { await Promise.all(clients.map((c) => c.close())); await app.close() }
for (const pid of readFileSync(join(project, '.fixture-pids'), 'utf8').trim().split('\n').map(Number)) {
  let alive = true
  try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw e }
  assert.equal(alive, false, `fixture ${pid} should exit with Cockpit`)
}
pass('quit closes every proof-owned provider process')
writeFileSync(join(PROOF_DIR, `mcp-control-${source}-result.json`), JSON.stringify({ checks, providerUsage: false, ...ids }, null, 2))
console.log(`PROOF AGENT CONTROLS PASS (${source}; ${checks} checks; no provider usage)`)
