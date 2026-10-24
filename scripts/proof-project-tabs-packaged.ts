// Exact packaged project controls; fictional folders and synthetic provider only.
// COCKPIT_APP=<proof .app> COCKPIT_PROOF_BACKGROUND=1 COCKPIT_PROOF_DIR=<evidence> tsx scripts/proof-project-tabs-packaged.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

mkdirSync(PROOF_DIR, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'cockpit-tabs-'))
const state = join(home, 'state')
const paths = ['Bakery', 'Garden', 'Notes'].map((name) => join(home, name))
for (const path of paths) { mkdirSync(path); writeFileSync(join(path, 'README.md'), '# Fictional\n') }
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') })
const page = await app.firstWindow()
page.setDefaultTimeout(15_000)
const tab = (name: string) => page.getByRole('tab', { name, exact: true })
const waitSaved = () => page.waitForFunction(() => !document.querySelector('.tab-control:disabled'))
const order = (names: string[]) => page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('.tabs .tab-name')].map((n) => n.textContent)) === JSON.stringify(expected), names)
const errors: string[] = [], checks: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
try {
  for (let i = 0; i < paths.length; i++) await openProject(page, paths[i]!, ['Bakery', 'Garden', 'Notes'][i])
  await tab('Bakery').click(); await order(['Bakery', 'Garden', 'Notes'])
  await tab('Notes').dragTo(tab('Bakery'), { targetPosition: { x: 5, y: 15 } })
  await order(['Notes', 'Bakery', 'Garden']); await waitSaved()
  const gardenBox = await tab('Garden').locator('..').boundingBox(); assert.ok(gardenBox)
  await tab('Notes').dragTo(tab('Garden').locator('..'), { targetPosition: { x: gardenBox.width - 3, y: 15 } })
  await order(['Bakery', 'Garden', 'Notes']); await waitSaved()
  checks.push('Native Electron title bar: real drag before and after tabs persists order')
  await tab('Garden').click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Set Garden colour to purple', exact: true }).click()
  await page.locator('.tab.tint-purple').filter({ has: tab('Garden') }).waitFor(); await waitSaved()
  assert.equal(await tab('Bakery').getAttribute('aria-selected'), 'true')
  checks.push('Inactive colour changes immediately without switching projects')
  await page.getByRole('button', { name: 'Project controls for Garden' }).click()
  await page.getByRole('menuitem', { name: 'Move left', exact: true }).click()
  await order(['Garden', 'Bakery', 'Notes']); await waitSaved()
  await page.reload(); await order(['Garden', 'Bakery', 'Notes'])
  assert.equal(await page.locator('.tab.tint-purple').filter({ has: tab('Garden') }).count(), 1)
  await page.getByRole('button', { name: 'Project controls for Garden' }).click()
  await page.getByRole('menuitem', { name: 'Project settings…', exact: true }).click()
  await page.getByRole('dialog', { name: 'Garden', exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Garden renamed')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await tab('Garden renamed').waitFor(); await page.keyboard.press('Escape')
  checks.push('Menu ordering, colour and direct settings persist across reload')
  await page.getByRole('button', { name: 'Close Bakery tab' }).click()
  await order(['Garden renamed', 'Notes']); await waitSaved()
  await page.getByRole('button', { name: 'Close Garden renamed tab' }).click()
  await order(['Notes']); await waitSaved()
  await page.getByRole('button', { name: 'Close Notes tab' }).click()
  await order([]); await waitSaved(); await page.reload(); await order([])
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem').filter({ hasText: 'Bakery' }).click()
  await order(['Bakery'])
  assert.equal(readFileSync(join(paths[0]!, 'README.md'), 'utf8'), '# Fictional\n')
  checks.push('Active/inactive/last tab close, reload and menu reopen leave files intact')
  const data = await apiPost(page, '/api/projects/tab', { path: paths[0], pinned: false, before: null }) as { error?: string }
  assert.ok(data.error)
  assert.deepEqual(errors, [])
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  await page.getByRole('button', { name: 'Project controls for Bakery' }).click()
  await page.screenshot({ path: join(PROOF_DIR, 'packaged-project-controls.png') })
  checks.push('Malformed patch rejected; zero browser runtime errors')
  writeFileSync(join(PROOF_DIR, 'receipt.json'), JSON.stringify({ status: 'PASS', version, checks, errors, evidence: 'packaged proof build; fictional state; real production UI; no provider usage' }, null, 2))
  console.log(`PROOF PACKAGED PROJECT TABS PASS (${checks.length} checks)`)
} catch (e) {
  await page.screenshot({ path: join(PROOF_DIR, 'failure.png') }).catch(() => {})
  writeFileSync(join(PROOF_DIR, 'receipt.json'), JSON.stringify({ status: 'FAIL', checks, errors, error: String(e) }, null, 2))
  throw e
} finally {
  await app.close()
}
