// Visual proof of each styled screen in a packaged app. All state lives in a disposable HOME.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:style-screens -- files
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const screen = process.argv[2]
if (screen !== 'files') throw new Error(`Unknown style screen: ${screen ?? '(none)'}`)
const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-style-screens-'))
const home = join(root, 'home'), project = join(root, 'garden')
mkdirSync(home)
mkdirSync(project)
mkdirSync(join(project, 'src'))
writeFileSync(join(project, 'README.md'), '# Garden\n\nA small synthetic project for the Files screen.\n')
writeFileSync(join(project, 'src', 'planting.ts'), 'export const season = "autumn"\n')
mkdirSync(PROOF_DIR, { recursive: true })
const store = createThreadStore(join(root, 'state'))
const shot = (page: Page, mode: string) => page.screenshot({ path: join(PROOF_DIR, `style-${screen}-${mode}.png`) })
const app = await launchPackagedApp({ HOME: home, SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'),
  COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') }, ['--use-mock-keychain'])
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1360, height: 860 })
  await openProject(page, project, 'Garden')
  await apiPost(page, '/api/projects', { path: project, color: 'green' })
  await page.reload()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'README.md' }).click()
  await page.locator('.file-preview header h2').getByText('README.md').waitFor()
  check('Files has a filled selected row and a breadcrumb under the title',
    await page.locator('.file-row.selected').count() === 1 && await page.locator('.file-breadcrumbs').getByText('Project files').count() === 1)
  check('Files keeps the green project tint', await page.locator('.app.tint-green').count() === 1)
  await page.getByRole('button', { name: 'Hide files' }).click()
  const hidden = await page.locator('.files-layout.explorer-hidden').count() === 1
  await page.getByRole('button', { name: 'Show files' }).click()
  check('the square beside the file title hides and restores the list', hidden && await page.locator('.files-layout.explorer-hidden').count() === 0)
  await page.getByRole('tab', { name: 'Your documents' }).click()
  const documentsActive = await page.locator('.file-spaces [aria-selected="true"]').getByText('Your documents').count() === 1
  await page.getByRole('tab', { name: 'Project files' }).click()
  check('Files space filters use an active filled pill', documentsActive && await page.locator('.file-spaces [aria-selected="true"]').getByText('Project files').count() === 1)
  await setTheme(page, 'Light')
  await shot(page, 'light')
  await setTheme(page, 'Dark')
  await shot(page, 'dark')
  await page.setViewportSize({ width: 980, height: 640 })
  const narrow = await page.evaluate(() => {
    const list = document.querySelector('.file-list')!.getBoundingClientRect()
    const detail = document.querySelector('.file-preview')!.getBoundingClientRect()
    return { pageFits: document.documentElement.scrollWidth <= innerWidth,
      columnsFit: list.right <= detail.left && detail.right <= innerWidth,
      toggleVisible: document.querySelector('.file-preview header .file-explorer-toggle')!.getBoundingClientRect().right <= detail.right }
  })
  check('Files fits 980 × 640', narrow.pageFits && narrow.columnsFit && narrow.toggleVisible, JSON.stringify(narrow))
  await shot(page, 'narrow-dark')
} catch (error) {
  check('proof reached Files', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
finish('PROOF FILES STYLE')
