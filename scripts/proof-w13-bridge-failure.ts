// Packaged negative gate: CLI protocol ready, Cockpit MCP bridge absent, first input held.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const root = mkdtempSync(join(tmpdir(), 'cockpit-w13-bridge-missing-'))
const project = join(root, 'project')
const marker = join(root, 'provider-read-user')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
writeFileSync(join(project, 'README.md'), '# W13 missing bridge proof\n')
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/recovery-agent'),
  COCKPIT_FIXTURE_NODE: process.execPath, COCKPIT_RECOVERY_FIXTURE: join(ROOT, 'scripts/fixtures/recovery-agent/agent.mjs'),
  COCKPIT_RECOVERY_SKIP_BRIDGE: '1', COCKPIT_RECOVERY_USER_MARKER: marker })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(25_000)
  await openProject(page, project, 'Missing bridge proof')
  await apiPost(page, '/api/projects', { path: project, claudeHooks: false, claudeMcp: false })
  const created = await apiPost(page, '/api/threads', { projectPath: project, text: 'Input must remain unsent',
    settings: { agent: 'claude', permissionMode: 'manual', hooksSetup: 'off', mcpSetup: 'off' } }) as { data?: { id: string } }
  assert.ok(created.data?.id)
  const id = created.data.id
  const deadline = Date.now() + 25_000
  let events: Array<{ kind: string; message?: string }> = []
  while (Date.now() < deadline) {
    events = await page.evaluate(async (threadId) => {
      const body = await (await fetch(`/api/threads/${threadId}/events`)).json() as { data: { events: Array<{ event: { kind: string; message?: string } }> } }
      return body.data.events.map(({ event }) => event)
    }, id)
    if (events.some((event) => event.kind === 'user_undelivered')) break
    await page.waitForTimeout(250)
  }
  assert.ok(events.some((event) => event.kind === 'user_undelivered'), 'First input was not marked undelivered')
  assert.ok(events.some((event) => event.kind === 'error' && event.message?.includes('MCP bridge did not authenticate')))
  assert.equal(existsSync(marker), false, 'Provider read the first user message before bridge authentication')
  const details = await page.evaluate(async (threadId) => (await (await fetch(`/api/threads/${threadId}/events`)).json()).data, id) as { meta: { sessionStarted?: boolean } }
  assert.equal(details.meta.sessionStarted, false)
  await page.locator('.card').filter({ hasText: 'Input must remain unsent' }).click()
  await page.screenshot({ path: join(PROOF_DIR, 'w13-bridge-failure.png') })
  console.log('W13 PACKAGED BRIDGE FAILURE PASS: protocol ready, host absent, first input undelivered')
} finally {
  await app.close()
}
