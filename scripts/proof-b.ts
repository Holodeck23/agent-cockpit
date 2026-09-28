// Phase B gates, run against the PACKAGED app (npm run package first).
//   tsx scripts/proof-b.ts b1   project tab bar, sub-nav, Projects menu, dark mode
// Real Haiku threads supply the live states: two working, one waiting on an approval.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'

mkdirSync(PROOF_DIR, { recursive: true })
const { check, finish } = checker()
const mode = process.argv[2] ?? 'b1'

const ESSAY = 'Write a 3000 word essay on the history of coffee. Plain text, no tools.'
const APPROVAL = 'Use the Write tool to create notes.txt containing hello. Do not ask questions.'

function folder(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cockpit-b-')), name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  return dir
}

/** Same-origin API calls from inside the page, so they pass the loopback guard like the UI does. */
async function apiPost(page: Page, path: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([p, b]) => {
      const res = await fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      return res.json() as Promise<unknown>
    },
    [path, body] as const,
  )
}

async function startThread(page: Page, projectPath: string, text: string): Promise<void> {
  await apiPost(page, '/api/threads', { projectPath, text, settings: { model: 'haiku', permissionMode: 'manual' } })
}

async function waitForStatuses(page: Page, want: { working: number; needs: number }): Promise<void> {
  await page.waitForFunction(
    async (w) => {
      const res = await fetch('/api/threads')
      const { data } = (await res.json()) as { data: Array<{ status: string }> }
      const working = data.filter((t) => t.status === 'working').length
      const needs = data.filter((t) => t.status === 'needs_input').length
      return working >= w.working && needs >= w.needs
    },
    want,
    { timeout: 90_000, polling: 500 },
  )
}

/** The whole window including the native traffic lights (needs Screen Recording permission). */
async function captureWindow(app: Awaited<ReturnType<typeof launchPackagedApp>>, file: string): Promise<boolean> {
  try {
    const sourceId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? '')
    const windowId = sourceId.split(':')[1]
    if (!windowId) return false
    execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

if (mode !== 'b1') throw new Error(`unknown mode ${mode}`)

const sprout = folder('sprout')
const bakery = folder('bakery-website')
const studio = folder('studio-portfolio')

const app = await launchPackagedApp()
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

for (const [path, name] of [
  [bakery, 'Bakery website'],
  [studio, 'Studio portfolio'],
  [sprout, 'Sprout'],
] as const) {
  await apiPost(page, '/api/projects', { path, name, pinned: true })
}
await startThread(page, bakery, APPROVAL)
await startThread(page, bakery, ESSAY)
await startThread(page, studio, ESSAY)
await apiPost(page, '/api/projects', { path: sprout })
await page.evaluate((path) => localStorage.setItem('cockpit:active-project', path), sprout)
await page.reload()
await waitForStatuses(page, { working: 2, needs: 1 })

const tabs = page.getByRole('tablist', { name: 'Projects' }).getByRole('tab')
await page.getByRole('tab', { name: /Bakery website/ }).getByLabel('1 need you').waitFor({ timeout: 15_000 })
const tabNames = await tabs.locator('.tab-name').allTextContents()
check('three pinned project tabs, alphabetical', tabNames.join(' | ') === 'Bakery website | Sprout | Studio portfolio', tabNames.join(' | '))
check('Sprout is the active tab', (await page.getByRole('tab', { selected: true, name: /Sprout/ }).count()) === 1)
check('Bakery tab shows 1 working + 1 needs you', (await page.getByRole('tab', { name: /Bakery website/ }).getByLabel('1 working').count()) === 1)
check('Studio tab shows 1 working', (await page.getByRole('tab', { name: /Studio portfolio/ }).getByLabel('1 working').count()) === 1)
const tabbarBg = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)
check('tab bar uses the topbar token (light)', tabbarBg === 'rgb(229, 229, 223)', tabbarBg)
const dragRegion = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
check('tab bar drags the window', dragRegion === 'drag', dragRegion)
await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-chrome.png') })
const fullWindow = await captureWindow(app, join(PROOF_DIR, 'phase-B1-window.png'))
console.log(fullWindow ? 'window capture with traffic lights: docs/proof/phase-B1-window.png' : 'window capture skipped (no Screen Recording permission)')

await page.getByRole('button', { name: 'Projects' }).click()
const menuItems = await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem').allTextContents()
check('Projects menu offers Open folder… and all three projects', menuItems.length === 4 && menuItems[0]?.includes('Open folder') === true, `${menuItems.length} items`)
await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-projects-menu.png') })
await page.keyboard.press('Escape')

await page.getByRole('tab', { name: /Bakery website/ }).click()
check('switching tabs filters conversations to that project', (await page.locator('.thread-row').count()) === 2)
check('sub-nav shows the working count', (await page.locator('.subnav').getByLabel('1 working').count()) === 1)

const themeButton = page.locator('.subnav-tools .icon-button')
while ((await themeButton.getAttribute('aria-label')) !== 'Theme: dark') await themeButton.click()
const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
const darkBg = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)
check('dark toggle switches tokens and native chrome', dark && darkBg === 'rgb(23, 23, 23)', `native dark=${dark}, tabbar ${darkBg}`)
await page.getByRole('tab', { name: /Sprout/ }).click()
await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-dark.png') })
await page.getByRole('button', { name: 'Files' }).or(page.getByRole('tab', { name: 'Files' })).first().click()
check('Files section shows its placeholder', await page.getByRole('heading', { name: 'Files' }).isVisible())
await themeButton.click() // back to system for the next run

await app.close()
finish('PHASE B1')
