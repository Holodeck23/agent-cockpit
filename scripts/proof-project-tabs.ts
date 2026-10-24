// Background source/browser proof. No installed app or real agent is launched.
// Usage: tsx scripts/proof-project-tabs.ts <durable-evidence-directory> (after npm run build).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { startServer } from '../server/start.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { tabOrder } from '../web/src/project-tabs.ts'

const out = process.argv[2]
if (!out) throw new Error('Pass a durable evidence directory')
mkdirSync(out, { recursive: true })
const fixture = join(out, 'fictional-runtime')
const state = join(fixture, 'state')
const paths = ['Bakery', 'Garden', 'Notes'].map((name) => join(fixture, name))
for (const path of paths) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'README.md'), '# Fictional project\n') }
const server = await startServer({ port: 0, webDist: resolve('dist'), stateRoot: state,
  agentProbe: async () => ({ installed: false, problem: 'No agents in this browser proof' }) })
for (const path of paths) server.projects.open(path, { pinned: true })
const now = new Date().toISOString()
const threadId = randomUUID()
server.store.create({ id: threadId, title: 'Saved fictional conversation', projectPath: paths[0]!,
  settings: threadSettingsSchema.parse({}), sessionId: 'fictional', sessionStarted: false, completed: true, createdAt: now, updatedAt: now })
const checks: string[] = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
page.setDefaultTimeout(10_000)
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
const tab = (name: string) => page.getByRole('tab', { name: new RegExp(name) })
const expectOrder = async (expected: string[]) => {
  await page.waitForFunction((names) => JSON.stringify([...document.querySelectorAll('[role="tablist"] .tab-name')].map((n) => n.textContent)) === JSON.stringify(names), expected)
}
const waitSaved = () => page.waitForFunction(() => !document.querySelector('.tab-control:disabled'))
try {
  await page.goto(server.url)
  await expectOrder(['Bakery', 'Garden', 'Notes'])
  await tab('Bakery').click()
  // Native HTML drag in a real browser, with explicit sides of the destination tab.
  await tab('Notes').dragTo(tab('Bakery'), { targetPosition: { x: 5, y: 15 } })
  await expectOrder(['Notes', 'Bakery', 'Garden']); await waitSaved()
  assert.deepEqual(tabOrder(server.projects.list(), undefined).map((p) => p.name), ['Notes', 'Bakery', 'Garden'])
  const gardenBox = await tab('Garden').locator('..').boundingBox()
  assert.ok(gardenBox)
  await tab('Notes').dragTo(tab('Garden').locator('..'), { targetPosition: { x: gardenBox.width - 3, y: 15 } })
  await expectOrder(['Bakery', 'Garden', 'Notes']); await waitSaved()
  await tab('Notes').dragTo(tab('Bakery'), { targetPosition: { x: 5, y: 15 } })
  await expectOrder(['Notes', 'Bakery', 'Garden']); await waitSaved()
  checks.push('Dragging before and after tabs reordered the real UI and persisted server order')
  await tab('Garden').click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Set Garden colour to purple', exact: true }).click()
  await page.locator('.tab.tint-purple').filter({ has: tab('Garden') }).waitFor(); await waitSaved()
  assert.equal(server.projects.list().find((p) => p.name === 'Garden')?.color, 'purple')
  assert.equal(await tab('Bakery').getAttribute('aria-selected'), 'true')
  checks.push('Right-click changed an inactive project colour without switching projects')
  await page.getByRole('button', { name: 'Project controls for Garden', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move left', exact: true }).click()
  await expectOrder(['Notes', 'Garden', 'Bakery']); await waitSaved()
  await page.reload(); await expectOrder(['Notes', 'Garden', 'Bakery'])
  assert.equal(await page.locator('.tab.tint-purple').filter({ has: tab('Garden') }).count(), 1)
  checks.push('Menu ordering and colour survived browser reload')
  await page.getByRole('button', { name: 'Project controls for Garden', exact: true }).click()
  await page.screenshot({ path: join(out, 'project-controls-wide.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 560, height: 760 })
  await page.getByRole('button', { name: 'Project controls for Garden', exact: true }).click()
  const menuBox = await page.getByRole('menu', { name: 'Garden controls' }).boundingBox()
  assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 560)
  await page.screenshot({ path: join(out, 'project-controls-narrow.png') })
  await page.keyboard.press('Escape')
  checks.push('Controls remained inside the narrow viewport; wide and narrow screenshots retained')
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.getByRole('button', { name: 'Close Bakery tab', exact: true }).click()
  await expectOrder(['Notes', 'Garden']); await waitSaved()
  assert.equal(await tab('Garden').getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: 'Close Notes tab', exact: true }).click()
  await expectOrder(['Garden']); await waitSaved()
  assert.equal(await tab('Garden').getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: 'Close Garden tab', exact: true }).click()
  await expectOrder([]); await waitSaved(); await page.reload(); await expectOrder([])
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem').filter({ hasText: 'Bakery' }).click()
  await expectOrder(['Bakery'])
  assert.equal(server.projects.list().length, 3)
  assert.ok(server.store.get(threadId))
  assert.equal(readFileSync(join(paths[0]!, 'README.md'), 'utf8'), '# Fictional project\n')
  checks.push('Active and inactive closes, last-tab reload and menu reopen preserved all projects, conversation and files')
  const invalid = await fetch(`${server.url}/api/projects/tab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: paths[0], instructions: 'not a tab control' }) })
  assert.equal(invalid.status, 400)
  assert.deepEqual(errors, [])
  checks.push('Malformed tab request refused; no browser runtime errors')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem').filter({ hasText: 'Garden' }).click()
  await expectOrder(['Bakery', 'Garden'])
  await page.getByRole('button', { name: 'Project controls for Garden', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Unpin project', exact: true }).click()
  await waitSaved()
  assert.equal(server.projects.list().find((p) => p.name === 'Garden')?.pinned, false)
  await tab('Garden').dragTo(tab('Bakery'), { targetPosition: { x: 5, y: 15 } })
  await expectOrder(['Garden', 'Bakery']); await waitSaved()
  assert.equal(server.projects.list().find((p) => p.name === 'Garden')?.pinned, true)
  checks.push('Dragging the active unpinned project gave it a persistent chosen position')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Project controls for Garden', exact: true }).click()
  await page.screenshot({ path: join(out, 'project-controls-dark.png') })
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ status: 'PASS', at: new Date().toISOString(), checks, errors, evidence: 'source and headless Chrome; no package or installed-app acceptance' }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ status: 'FAIL', checks, errors, error: String(error) }, null, 2))
  throw error
} finally {
  await browser.close(); await server.close()
}
