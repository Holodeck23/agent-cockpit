// Projects-area tabs gate (NAV-01–NAV-05), run against the PACKAGED app (npm run package:proof first): `npm run proof:tabs`.
// No agent usage. Three invented projects in a temp folder: drag the third tab to the front, ⌘1 opens it,
// × closes it (unpinned, still in Cockpit), right-click → pink, Shift+F10 and ⌥⇧→ from the keyboard,
// and the order survives a reload. A press that moves less than 4 px is still a click.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

interface Project { path: string; name: string; color: string; pinned: boolean; pinOrder?: number }
const home = mkdtempSync(join(tmpdir(), 'cockpit-tabs-proof-'))
const state = join(home, 'state')
const folders = { Tidepool: join(home, 'tidepool'), Lantern: join(home, 'lantern'), Atlas: join(home, 'atlas') }
for (const dir of Object.values(folders)) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# demo\n') }

const tabNames = (page: Page): Promise<string[]> =>
  page.getByRole('tablist', { name: 'Projects' }).locator('.tab .tab-name').allTextContents()
const activeName = (page: Page): Promise<string | null> => page.locator('.tab.active .tab-name').textContent()
const stored = (): Project[] => JSON.parse(readFileSync(join(state, 'projects.json'), 'utf8')) as Project[]
const tab = (page: Page, name: string) => page.locator('.tab').filter({ has: page.locator('.tab-name', { hasText: name }) })
async function dragTab(page: Page, name: string, toLeftOf: string): Promise<void> {
  const from = (await tab(page, name).boundingBox())!
  const to = (await tab(page, toLeftOf).boundingBox())!
  const y = from.y + from.height / 2
  await page.mouse.move(from.x + from.width / 2, y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(from.x + from.width / 2 + ((to.x + 4) - (from.x + from.width / 2)) * (i / 10), y)
  await page.mouse.up()
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: state })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  for (const [name, dir] of Object.entries(folders)) await openProject(page, dir, name)
  check('three pinned tabs in the order they were pinned', JSON.stringify(await tabNames(page)) === JSON.stringify(['Tidepool', 'Lantern', 'Atlas']), (await tabNames(page)).join(', '))

  // NAV-01: a 2 px wobble is still a click; a real drag reorders.
  await tab(page, 'Tidepool').locator('.tab-main').click()
  const lantern = (await tab(page, 'Lantern').boundingBox())!
  await page.mouse.move(lantern.x + lantern.width / 2, lantern.y + lantern.height / 2)
  await page.mouse.down()
  await page.mouse.move(lantern.x + lantern.width / 2 + 2, lantern.y + lantern.height / 2)
  await page.mouse.up()
  check('NAV-01 a press that moves 2 px selects the tab and reorders nothing', await activeName(page) === 'Lantern'
    && JSON.stringify(await tabNames(page)) === JSON.stringify(['Tidepool', 'Lantern', 'Atlas']), `${await activeName(page)} / ${(await tabNames(page)).join(', ')}`)
  await dragTab(page, 'Atlas', 'Tidepool')
  await page.waitForFunction(() => document.querySelector('.tab .tab-name')?.textContent === 'Atlas')
  check('NAV-01 dragging the third tab to the front puts it first', JSON.stringify(await tabNames(page)) === JSON.stringify(['Atlas', 'Tidepool', 'Lantern']), (await tabNames(page)).join(', '))
  check('NAV-01 the drag did not select the dragged tab', await activeName(page) === 'Lantern', String(await activeName(page)))
  const orders = Object.fromEntries(stored().map((p) => [p.name, p.pinOrder]))
  check('NAV-01 the new order is saved as pin order', orders.Atlas === 1 && orders.Tidepool === 2 && orders.Lantern === 3, JSON.stringify(orders))

  // NAV-02: ⌘1 follows the new order.
  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.keyboard.press('Meta+Digit1')
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'Atlas')
  check('NAV-02 ⌘1 opens the tab now first', await activeName(page) === 'Atlas')

  // NAV-03: × closes the tab; the project stays in Cockpit.
  await page.getByRole('button', { name: 'Close Atlas', exact: true }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.tab .tab-name')].some((n) => n.textContent === 'Atlas'))
  check('NAV-03 × takes the tab away and opens the next one', JSON.stringify(await tabNames(page)) === JSON.stringify(['Tidepool', 'Lantern']) && await activeName(page) === 'Tidepool',
    `${(await tabNames(page)).join(', ')} / ${await activeName(page)}`)
  const atlas = stored().find((p) => p.name === 'Atlas')
  check('NAV-03 the closed project is unpinned, not removed', atlas?.pinned === false && !('hidden' in (atlas ?? {})), JSON.stringify(atlas))
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  check('NAV-03 it is still listed in the Projects menu', await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem', { name: /Atlas/ }).count() === 1)
  await page.keyboard.press('Escape')

  // NAV-04: right-click → colour.
  await tab(page, 'Lantern').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Lantern tab' })
  await menu.waitFor()
  check('NAV-04 the tab menu offers colour, pin, close, settings and remove', await menu.getByRole('menuitemradio').count() === 6
    && await menu.getByRole('menuitem', { name: 'Unpin' }).count() === 1 && await menu.getByRole('menuitem', { name: 'Close tab' }).count() === 1
    && await menu.getByRole('menuitem', { name: 'Project settings…' }).count() === 1 && await menu.getByRole('menuitem', { name: 'Remove from Cockpit…' }).count() === 1)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-tabs-menu.png') })
  await menu.getByRole('menuitemradio', { name: 'Pink' }).click()
  await page.locator('.tab.tint-pink').filter({ hasText: 'Lantern' }).waitFor()
  check('NAV-04 choosing pink tints the tab and saves it', stored().find((p) => p.name === 'Lantern')?.color === 'pink')
  await tab(page, 'Lantern').locator('.tab-main').focus()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor()
  check('NAV-04 Shift+F10 opens the same menu from the keyboard', await menu.isVisible())
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  await tab(page, 'Lantern').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Project settings…' }).click()
  await page.locator('.project-settings').waitFor()
  check('NAV-04 Project settings… opens that project\'s settings', await page.locator('.project-settings').getByRole('textbox', { name: 'Project name' }).inputValue() === 'Lantern')
  await page.keyboard.press('Escape')
  await page.locator('.project-settings').waitFor({ state: 'detached' })

  // NAV-05: ⌥⇧→ moves a focused tab; the order survives a reload.
  await tab(page, 'Tidepool').locator('.tab-main').focus()
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await page.waitForFunction(() => document.querySelector('.tab .tab-name')?.textContent === 'Lantern')
  check('NAV-05 ⌥⇧→ moves the focused tab right', JSON.stringify(await tabNames(page)) === JSON.stringify(['Lantern', 'Tidepool']), (await tabNames(page)).join(', '))
  await page.reload()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  check('NAV-05 the order survives a reload', JSON.stringify(await tabNames(page)) === JSON.stringify(['Lantern', 'Tidepool']), (await tabNames(page)).join(', '))
  const fields = new Set(stored().flatMap((p) => Object.keys(p)))
  check('projects.json gained no new field', [...fields].every((f) => ['path', 'name', 'color', 'pinned', 'pinOrder', 'lastOpenedAt'].includes(f)), [...fields].join(','))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-tabs.png') })
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-tabs-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF TABS')
