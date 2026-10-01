// U6 appearance gate, run against the PACKAGED app (npm run package first): `npm run proof:appearance`.
// No agent usage: conversations are answered by the stand-in (scripts/fixtures/echo-agent).
// The top bar's Appearance popover sets the theme (page tokens and native chrome), Normal/Compact for
// the conversation list and for messages, and what list rows show; every choice survives a restart.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

interface Summary { meta: { id: string; title: string }; status: string; preview: string }

const home = mkdtempSync(join(tmpdir(), 'cockpit-appearance-proof-'))
const project = join(home, 'appearance-demo')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# appearance demo\n')
const env = { COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') }
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const html = (page: Page, key: string): Promise<string | undefined> => page.evaluate((k) => document.documentElement.dataset[k], key)
const panel = (page: Page) => page.getByRole('dialog', { name: 'Appearance' })
const radio = (page: Page, group: string, name: string) => panel(page).getByRole('radiogroup', { name: group }).getByRole('radio', { name, exact: true })
const open = async (page: Page): Promise<void> => { await page.getByRole('button', { name: 'Appearance', exact: true }).click(); await panel(page).waitFor() }
const height = (page: Page, selector: string): Promise<number> => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().height)
const firstMeta = (page: Page): Promise<string> => page.locator('.card .card-meta').first().innerText()

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
let app: ElectronApplication = await launchPackagedApp(env)
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  await openProject(page, project, 'Appearance demo')
  for (const text of ['Tidy the README headings', 'Explain how the build works']) await apiPost(page, '/api/threads', { projectPath: project, text })
  const deadline = Date.now() + 20_000
  let threads: Summary[] = []
  while (Date.now() < deadline) {
    threads = await getJson<Summary[]>(page, '/api/threads')
    if (threads.length === 2 && threads.every((t) => t.status !== 'working' && t.preview)) break
    await page.waitForTimeout(500)
  }
  check('two answered conversations to look at', threads.length === 2 && threads.every((t) => t.preview), threads.map((t) => t.status).join(', '))
  await page.locator('.card').filter({ hasText: 'Tidy the README' }).click()
  await page.locator('.bubble').first().waitFor()

  const before = { card: await height(page, '.card'), bubble: await height(page, '.bubble'), meta: await firstMeta(page) }
  check('defaults keep the original look: agent and date, no preview', /Claude Code · Today/.test(before.meta) && await page.locator('.card-preview').count() === 0, before.meta)

  await open(page)
  check('the popover offers theme, both densities and row parts', await radio(page, 'Theme', 'System').getAttribute('aria-checked') === 'true'
    && await radio(page, 'Conversation list', 'Normal').isVisible() && await radio(page, 'Messages', 'Normal').isVisible()
    && await panel(page).getByRole('checkbox').count() === 3)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-appearance.png') })

  await radio(page, 'Theme', 'Dark').click()
  const nativeDark = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource === 'dark' && nativeTheme.shouldUseDarkColors)
  check('Dark switches the page and the native chrome', await html(page, 'theme') === 'dark' && nativeDark)

  await radio(page, 'Conversation list', 'Compact').click()
  await radio(page, 'Messages', 'Compact').click()
  const after = { card: await height(page, '.card'), bubble: await height(page, '.bubble') }
  check('Compact list makes rows shorter', after.card < before.card - 8, `${before.card} → ${after.card}`)
  check('Compact messages make bubbles tighter', after.bubble < before.bubble, `${before.bubble} → ${after.bubble}`)

  await panel(page).getByRole('checkbox', { name: 'Message preview' }).check()
  await panel(page).getByRole('checkbox', { name: 'Agent' }).uncheck()
  const preview = threads.find((t) => t.meta.title.startsWith('Tidy'))!.preview
  check('rows can show the message preview', (await page.locator('.card').filter({ hasText: 'Tidy the README' }).locator('.card-preview').innerText()).trim() === preview, preview)
  check('rows can leave out the agent', (await firstMeta(page)).trim() === 'Today', await firstMeta(page))
  await page.keyboard.press('Escape')
  check('Escape closes the popover', await panel(page).count() === 0)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-appearance-compact-dark.png') })

  await app.close()
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  await page.locator('.card').first().waitFor()
  await open(page)
  const kept = await html(page, 'theme') === 'dark' && await html(page, 'listDensity') === 'compact' && await html(page, 'messageDensity') === 'compact'
    && await radio(page, 'Theme', 'Dark').getAttribute('aria-checked') === 'true'
    && await panel(page).getByRole('checkbox', { name: 'Message preview' }).isChecked()
    && !(await panel(page).getByRole('checkbox', { name: 'Agent' }).isChecked())
    && await page.locator('.card-preview').count() === 2
  check('every choice is remembered after a restart', kept)
  const nativeAfter = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
  check('the native chrome comes back dark too', nativeAfter === 'dark', nativeAfter)

  await radio(page, 'Theme', 'System').click()
  check('System hands the theme back to macOS', await html(page, 'theme') === undefined && await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'system')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-appearance-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF APPEARANCE')
