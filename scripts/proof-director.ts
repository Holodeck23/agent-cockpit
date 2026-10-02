// First-run entry checkpoint. Local protocol stand-in; real approval, process and PNG inspection.
// Timing here is fixture plumbing, not the live-provider Phase 9 activation gate.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus } from './lib/ui.ts'

mkdirSync(PROOF_DIR, { recursive: true })
const fixture = join(ROOT, 'scripts/fixtures/onboarding-agent')
const home = mkdtempSync(join(tmpdir(), 'cockpit-director-proof-'))
const project = mkdtempSync(join(tmpdir(), 'cockpit-first-project-'))
writeFileSync(join(project, 'README.md'), '# First project\nA synthetic project for the director proof.\n')
const env = { COCKPIT_HOME: home, COCKPIT_AGENT_PATH: fixture }
let app = await launchPackagedApp(env)
let checks = 0
function pass(label: string) { checks++; console.log(`PASS ${label}`) }
try {
  let page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  const entry = () => page.getByRole('heading', { name: 'Pick up where you left off.' })
  await entry().waitFor()
  await page.getByRole('button', { name: 'Try a 90-second sample' }).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('button', { name: 'Agent settings' }).count(), 0)
  pass('fresh home opens the director without advanced setup controls')
  await page.getByText('Using Claude Code with its default model.', { exact: true }).waitFor()
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9-director-light.png') })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9-director-dark.png') })
  await page.setViewportSize({ width: 640, height: 800 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9-director-narrow.png') })
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  pass('light, dark and narrow layouts fit without horizontal overflow')

  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.getByRole('button', { name: 'Open a project', exact: true }).waitFor()
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/threads')).json()).data.length), 0)
  pass('canceling the native picker creates no conversation')

  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.getByRole('button', { name: 'Explore this project' }).waitFor()
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/threads')).json()).data.length), 0)
  pass('folder selection stages orientation without launching an agent')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  pass('skip after choosing a folder opens that project in the workspace')
  await app.close()
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  await page.getByRole('heading', { name: 'New conversation', exact: true }).waitFor()
  assert.equal(await entry().count(), 0)
  pass('skip stays dismissed after a packaged-app restart')

  await app.close()
  const sampleHome = mkdtempSync(join(tmpdir(), 'cockpit-sample-proof-'))
  app = await launchPackagedApp({ ...env, COCKPIT_HOME: sampleHome })
  page = await app.firstWindow()
  page.setDefaultTimeout(25_000)
  await page.route('**/api/agents', (route) => route.fulfill({ json: { data: [] } }))
  await page.reload()
  await page.getByText('No supported agent found.', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Try a 90-second sample' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Skip for now' }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Open a project', exact: true }).isEnabled(), true)
  pass('missing agents leave open-project and skip available without a fake sample')
  await page.unroute('**/api/agents')
  await page.reload()
  await page.getByRole('button', { name: 'Try a 90-second sample' }).click()
  const approval = page.locator('.approval.open')
  await approval.waitFor()
  const threads = await page.evaluate(async () => (await (await fetch('/api/threads')).json()).data)
  assert.equal(threads.length, 1)
  assert.deepEqual(threads[0].meta.settings, { agent: 'claude', permissionMode: 'manual', useHooks: false })
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/processes')).json()).data.length), 0)
  pass('automatic installed-agent defaults ask before starting the sample')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9-director-approval.png') })
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await page.getByRole('complementary', { name: 'App preview' }).waitFor()
  assert.equal(await page.getByText('inspected its PNG: yes', { exact: false }).isVisible(), true)
  const frame = page.frameLocator('.preview-pane iframe')
  await frame.getByRole('heading', { name: 'Your first flight.' }).waitFor()
  await frame.getByRole('button', { name: 'Count a launch' }).click()
  await frame.getByText('1 launch', { exact: true }).waitFor()
  assert.equal(await page.getByText(/Use Cockpit's start_process tool with command/).count(), 0)
  pass('sample renders, responds to a click, and the agent receives a real PNG')
  assert.equal(await page.locator('.thread').evaluate((thread) => {
    const edge = thread.getBoundingClientRect().right
    return [...thread.querySelectorAll('.bubble')].every((bubble) => bubble.getBoundingClientRect().right <= edge + 1)
  }), true)
  pass('conversation text fits beside the preview')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-9-director-preview.png') })
  const processes = await page.evaluate(async () => (await (await fetch('/api/processes')).json()).data)
  assert.equal(processes.length, 1)
  assert.match(processes[0].command, /ELECTRON_RUN_AS_NODE=1 .*Cockpit.* server\.cjs/)
  pass('sample runs on the packaged runtime without installing dependencies')
  const pid = processes[0].pid
  await app.close()
  assert.throws(() => process.kill(pid, 0))
  pass('quitting stops the sample process')
  console.log(`PROOF DIRECTOR PASS (${checks} checks; no provider usage)`)
} catch (error) {
  const page = await app.firstWindow().catch(() => undefined)
  await page?.screenshot({ path: join(PROOF_DIR, 'phase-9-director-failure.png') }).catch(() => {})
  await app.close().catch(() => {})
  throw error
}
