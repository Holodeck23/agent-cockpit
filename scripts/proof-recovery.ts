// Packaged 9b checkpoint: real import, approval and stdio MCP/preview; synthetic provider.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_SESSION, writeImportHome } from './lib/import-fixtures.ts'
import { SAMPLE_SERVER } from '../server/onboarding/sample.ts'
import { claudeProjectDir } from '../server/import/sessions.ts'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus } from './lib/ui.ts'

const root = mkdtempSync(join(tmpdir(), 'cockpit-recovery-proof-'))
const project = join(root, 'garden-app'), home = join(root, 'state'), importHome = join(root, 'imports')
mkdirSync(project); mkdirSync(PROOF_DIR, { recursive: true })
execFileSync('git', ['init', '-b', 'feature/theme', project])
writeFileSync(join(project, 'server.cjs'), SAMPLE_SERVER)
writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }))
writeImportHome(importHome, project)
const source = join(claudeProjectDir(importHome, project), `${CLAUDE_SESSION}.jsonl`), before = readFileSync(source)
const env = { COCKPIT_HOME: home, COCKPIT_IMPORT_HOME: importHome, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/recovery-agent'),
  COCKPIT_FIXTURE_NODE: process.execPath, COCKPIT_RECOVERY_FIXTURE: join(ROOT, 'scripts/fixtures/recovery-agent/agent.mjs'), COCKPIT_FIXTURE_MCP: join(ROOT, 'dist-electron/mcp.cjs') }
let app = await launchPackagedApp(env)
let checks = 0
const pass = (label: string) => { checks++; console.log(`PASS ${label}`) }
try {
  let page = await app.firstWindow()
  page.setDefaultTimeout(25_000)
  await page.getByRole('button', { name: 'Open a project', exact: true }).waitFor()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  const card = () => page.getByRole('region', { name: 'Recent work' })
  await card().getByRole('button', { name: 'Resume and show me the app' }).waitFor()
  await card().getByLabel('Recent conversation').selectOption(`claude:${CLAUDE_SESSION}`)
  assert.match(await card().innerText(), /Now make it follow the system setting/)
  assert.match(await card().innerText(), /feature\/theme/)
  await card().getByText('Changed files now').click()
  assert.match(await card().innerText(), /server.cjs/)
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/threads')).json()).data.length), 0)
  pass('selecting a project discovers its task, agent, current branch and files without a launch')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-light.png') })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-dark.png') })
  await page.setViewportSize({ width: 640, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-narrow.png') })
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  pass('recovery fits light, dark and narrow layouts')
  await card().getByRole('button', { name: 'Resume and show me the app' }).click()
  const approval = page.locator('.approval.open')
  await approval.waitFor()
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/processes')).json()).data.length), 0)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-approval.png') })
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.getByText(`Resumed ${CLAUDE_SESSION}.`, { exact: false }).waitFor()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await page.frameLocator('.preview-pane iframe').getByRole('heading', { name: 'Your first flight.' }).waitFor()
  await page.frameLocator('.preview-pane iframe').getByRole('button', { name: 'Count a launch' }).click()
  await page.frameLocator('.preview-pane iframe').getByText('1 launch', { exact: true }).waitFor()
  const detail = await page.evaluate(async () => { const rows = (await (await fetch('/api/threads')).json()).data; return (await (await fetch(`/api/threads/${rows[0].meta.id}/events`)).json()).data })
  assert.equal(detail.events.filter((e: { event: { kind: string } }) => e.event.kind === 'approval_request').length, 1)
  assert.equal(await page.getByText('Added the toggle; it remembers the choice.', { exact: true }).count(), 1)
  assert.deepEqual(readFileSync(source), before)
  pass('one startup approval resumes the original session, preserves history and opens an inspected interactive preview')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-preview.png') })
  const meta = await page.evaluate(async () => (await (await fetch('/api/threads')).json()).data[0].meta)
  assert.deepEqual(meta.settings, { agent: 'claude', permissionMode: 'manual', useHooks: false })
  const processes = await page.evaluate(async () => (await (await fetch('/api/processes')).json()).data)
  assert.equal(processes.length, 1)
  await app.close()
  assert.throws(() => process.kill(processes[0].pid, 0))
  pass('safe defaults persist and the managed server closes with Cockpit')
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  await page.getByRole('heading', { name: 'New conversation', exact: true }).waitFor()
  await page.getByRole('region', { name: 'Recent work' }).getByRole('button', { name: 'Resume and show me the app' }).waitFor()
  assert.equal(await page.evaluate(async (path) => (await (await fetch(`/api/recovery?${new URLSearchParams({ projectPath: path })}`)).json()).data.choices.filter((c: { sessionId: string }) => c.sessionId === '0f6c2b8e-1d3a-4c5b-9e7f-2a1b3c4d5e6f').length, project), 1)
  pass('returning to an existing project offers recovery without duplicate imported history')
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click()
  await page.getByRole('heading', { name: 'What are you working on?' }).waitFor()
  pass('start fresh returns to the ordinary composer')
  console.log(`PROOF RECOVERY PASS (${checks} checks; synthetic provider, real MCP tools)`)
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(PROOF_DIR, 'phase-9b-recovery-failure.png') }).catch(() => {})
  throw error
} finally { await app.close().catch(() => {}) }
