// U8 project-settings gate, run against the PACKAGED app (npm run package first): `npm run proof:project-settings`.
// No agent usage: the agent is the approval stand-in (scripts/fixtures/ask-agent).
// Rename, tab tint and picture from the project settings dialog; Open in Finder only for known
// projects; Remove from Cockpit refused while an agent there waits, then hides the project, pauses
// its schedules and leaves the folder and conversations alone; opening the folder brings it back.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

interface Project { path: string; name: string; color: string; pinned: boolean; image?: string }
const home = mkdtempSync(join(tmpdir(), 'cockpit-project-proof-'))
const state = join(home, 'state')
const bakery = join(home, 'bakery-site')
const notes = join(home, 'field-notes')
for (const dir of [bakery, notes]) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# demo\n') }
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const project = async (page: Page, path: string): Promise<Project | undefined> => (await getJson<Project[]>(page, '/api/projects')).find((p) => p.path === path)
const dialog = (page: Page) => page.getByRole('dialog', { name: /settings|Bakery/ })
async function openSettings(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: `${name} settings…` }).click()
  await page.locator('.project-settings').waitFor()
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/ask-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)
// Record what Cockpit asks Finder to open, instead of opening it.
await app.evaluate(({ shell }) => {
  const opened: string[] = []
  ;(globalThis as unknown as { opened: string[] }).opened = opened
  Object.assign(shell, { openPath(path: string) { opened.push(path); return Promise.resolve('') } })
})
const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)

try {
  await openProject(page, notes, 'Field notes')
  await openProject(page, bakery, 'Bakery site')
  await openSettings(page, 'Bakery site')
  const settings = page.locator('.project-settings')
  await settings.getByRole('textbox', { name: 'Project name' }).fill('Bakery shop')
  await settings.getByRole('radiogroup', { name: 'Tab tint' }).getByRole('radio', { name: 'Green' }).click()
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('tab', { name: /Bakery shop/ }).waitFor()
  const renamed = await project(page, bakery)
  check('rename and tint are saved', renamed?.name === 'Bakery shop' && renamed.color === 'green', `${renamed?.name} ${renamed?.color}`)
  check('the tab shows the new name in its tint', await page.locator('.tab.tint-green').filter({ hasText: 'Bakery shop' }).count() === 1)

  // A test picture drawn here: a warm gradient with a loaf-like shape, larger than the avatar and not square.
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
    const g = canvas.getContext('2d')!
    const fill = g.createLinearGradient(0, 0, 640, 480); fill.addColorStop(0, '#f6b26b'); fill.addColorStop(1, '#c0504d')
    g.fillStyle = fill; g.fillRect(0, 0, 640, 480)
    g.fillStyle = '#fff3e0'; g.beginPath(); g.ellipse(320, 260, 150, 95, 0, 0, Math.PI * 2); g.fill()
    g.strokeStyle = '#c98b4f'; g.lineWidth = 14
    for (const x of [250, 320, 390]) { g.beginPath(); g.moveTo(x - 20, 215); g.lineTo(x + 20, 300); g.stroke() }
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  writeFileSync(join(home, 'bakery.png'), Buffer.from(picture, 'base64'))
  await settings.getByLabel('Choose a picture').setInputFiles(join(home, 'bakery.png'))
  await page.locator('.tab.active .avatar.has-image img').waitFor()
  const size = await page.locator('.tab.active .avatar img').evaluate((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight])
  check('a chosen picture replaces the letter, scaled to a 128 px square', size[0] === 128 && size[1] === 128, size.join('×'))
  check('the picture is kept by Cockpit, not in the project folder', readdirSync(join(state, 'project-images')).length === 1
    && JSON.stringify(readdirSync(bakery)) === JSON.stringify(['README.md']))
  writeFileSync(join(home, 'not-a-picture.png'), 'this is text')
  await settings.getByLabel('Choose a picture').setInputFiles(join(home, 'not-a-picture.png'))
  await settings.locator('..').getByRole('alert').filter({ hasText: 'not a picture Cockpit can read' }).waitFor()
  check('a file that is not an image is refused, the old picture kept', Boolean((await project(page, bakery))?.image)
    && await page.locator('.tab.active .avatar.has-image').count() === 1)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-project-settings.png'), mask: [settings.locator('.modal-path')] })

  await settings.getByRole('button', { name: 'Open in Finder' }).click()
  await page.evaluate((path) => (window as unknown as { cockpit: { openFolder(p: string): void } }).cockpit.openFolder(path), home)
  await page.waitForTimeout(500)
  check('Open in Finder opens the project folder and nothing else', JSON.stringify(await opened()) === JSON.stringify([bakery]), (await opened()).length.toString())

  // A conversation waiting on the agent blocks removal.
  await page.keyboard.press('Escape')
  await apiPost(page, '/api/threads', { projectPath: bakery, text: 'Waits for a decision' })
  await page.locator('.card').filter({ hasText: 'Waits for a decision' }).waitFor()
  await page.locator('.approval.open').first().waitFor().catch(async () => { await page.locator('.card').first().click(); await page.locator('.approval.open').first().waitFor() })
  const flow = await apiPost(page, '/api/workflows', { projectPath: bakery, name: 'nightly-check', prompt: 'Run the tests.', intervalMinutes: 60 }) as { data: { id: string } }
  await apiPost(page, `/api/workflows/${flow.data.id}/enabled`, { enabled: true })
  await openSettings(page, 'Bakery shop')
  await settings.getByRole('button', { name: 'Remove from Cockpit…' }).click()
  await settings.getByRole('button', { name: 'Remove from Cockpit', exact: true }).click()
  const refusal = await settings.getByRole('alert').innerText()
  check('removal is refused while a conversation there waits', /still working or waiting/.test(refusal) && Boolean(await project(page, bakery)), refusal)
  await page.keyboard.press('Escape')
  await page.locator('.card').filter({ hasText: 'Waits for a decision' }).click()
  for (const step of ['echo step 1', 'echo step 2']) {
    const card = page.locator('.approval.open').filter({ hasText: step })
    await card.waitFor()
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
  }
  await page.locator('.thread-status').filter({ hasText: 'Ready' }).waitFor()

  await openSettings(page, 'Bakery shop')
  await settings.getByRole('button', { name: 'Remove from Cockpit…' }).click()
  await settings.getByRole('button', { name: 'Remove from Cockpit', exact: true }).click()
  await settings.waitFor({ state: 'detached' })
  await page.getByRole('tab', { name: /Field notes/ }).waitFor()
  check('the project leaves the tabs and the menu', await page.getByRole('tab', { name: /Bakery shop/ }).count() === 0 && !(await project(page, bakery)))
  check('its folder and files are untouched', existsSync(join(bakery, 'README.md')))
  const threads = await getJson<Array<{ meta: { projectPath: string } }>>(page, '/api/threads')
  check('its conversations stay saved', threads.filter((t) => t.meta.projectPath === bakery).length === 1)
  const flows = await getJson<Array<{ enabled: boolean; nextRunAt: string | null }>>(page, `/api/workflows?projectPath=${encodeURIComponent(bakery)}`)
  check('its schedules are paused', flows.length === 1 && !flows[0]!.enabled && flows[0]!.nextRunAt === null)
  await page.reload()
  await page.getByRole('tab', { name: /Field notes/ }).waitFor()
  check('its conversations do not bring it back on their own', !(await project(page, bakery)))

  await apiPost(page, '/api/projects', { path: bakery, pinned: true })
  const back = await project(page, bakery)
  check('opening the folder again brings it back with its name, tint and picture', back?.name === 'Bakery shop' && back.color === 'green' && Boolean(back.image))
  await page.evaluate((path) => localStorage.setItem('cockpit:active-project', path), bakery)
  await page.reload()
  await page.locator('.tab.active .avatar.has-image img').waitFor()
  await page.screenshot({ path: join(PROOF_DIR, 'proof-project-tabs.png') })
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-project-settings-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF PROJECT SETTINGS')
