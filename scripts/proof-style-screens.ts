// Visual proof of each styled screen in a packaged app. All state lives in a disposable HOME.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:style-screens -- files|workflows
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const screen = process.argv[2]
if (screen !== 'files' && screen !== 'workflows') throw new Error(`Unknown style screen: ${screen ?? '(none)'}`)
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
const now = new Date().toISOString()
const base = { projectPath: project, settings: { agent: 'claude', permissionMode: 'plan', useHooks: false }, createdAt: now, updatedAt: now, archived: false }
writeFileSync(join(store.root, 'workflows.json'), JSON.stringify([
  { ...base, id: randomUUID(), name: 'nightly-check', title: 'Nightly check', collection: 'Quality', prompt: 'Run the tests and report the failures.', intervalMinutes: 1440, enabled: true, nextRunAt: new Date(Date.now() + 86_400_000).toISOString() },
  { ...base, id: randomUUID(), name: 'release-review', title: 'Release review', collection: 'Quality', prompt: 'Read the release checklist and summarize what remains.', intervalMinutes: null, enabled: false, nextRunAt: null },
], null, 2))
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
  if (screen === 'files') {
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.locator('.file-row').filter({ hasText: 'README.md' }).click()
    await page.locator('.file-preview header h2').getByText('README.md').waitFor()
    check('Files has a filled selected row and a breadcrumb under the title',
      await page.locator('.file-row.selected').count() === 1 && await page.locator('.file-breadcrumbs').getByText('Project files').count() === 1)
    await page.getByRole('button', { name: 'Hide files' }).click()
    const hidden = await page.locator('.files-layout.explorer-hidden').count() === 1
    await page.getByRole('button', { name: 'Show files' }).click()
    check('the square beside the file title hides and restores the list', hidden && await page.locator('.files-layout.explorer-hidden').count() === 0)
    await page.getByRole('tab', { name: 'Your documents' }).click()
    const documentsActive = await page.locator('.file-spaces [aria-selected="true"]').getByText('Your documents').count() === 1
    await page.getByRole('tab', { name: 'Project files' }).click()
    check('Files space filters use an active filled pill', documentsActive && await page.locator('.file-spaces [aria-selected="true"]').getByText('Project files').count() === 1)
  } else {
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    await page.locator('.workflow-row').filter({ hasText: 'Nightly check' }).click()
    await page.locator('.workflow-editor h1').getByText('Nightly check').waitFor()
    check('Workflows has a filled selected row, right status pill, and breadcrumbs',
      await page.locator('.workflow-row.selected .workflow-status.scheduled').getByText('Scheduled').count() === 1
      && await page.locator('.workflow-breadcrumbs').getByText('Saved workflow').count() === 1)
    await page.getByRole('button', { name: 'Hide workflows' }).click()
    const hidden = await page.locator('.workflows-layout.list-hidden').count() === 1
    await page.getByRole('button', { name: 'Show workflows' }).click()
    check('the square beside the workflow title hides and restores the list', hidden && await page.locator('.workflows-layout.list-hidden').count() === 0)
    await page.getByRole('tab', { name: /Scheduled/ }).click()
    const scheduledActive = await page.locator('.workflow-views [aria-selected="true"]').getByText('Scheduled').count() === 1
    await page.getByRole('tab', { name: /All/ }).click()
    check('Workflows filters use an active filled pill', scheduledActive && await page.locator('.workflow-views [aria-selected="true"]').getByText('All').count() === 1)
  }
  check(`${screen} keeps the green project tint`, await page.locator('.app.tint-green').count() === 1)
  await setTheme(page, 'Light')
  await shot(page, 'light')
  await setTheme(page, 'Dark')
  await shot(page, 'dark')
  await page.setViewportSize({ width: 980, height: 640 })
  const narrow = await page.evaluate((which) => {
    const list = document.querySelector(which === 'files' ? '.file-list' : '.workflow-list')!.getBoundingClientRect()
    const detail = document.querySelector(which === 'files' ? '.file-preview' : '.workflow-editor')!.getBoundingClientRect()
    const toggle = document.querySelector(which === 'files' ? '.file-preview header .file-explorer-toggle' : '.workflow-editor header .workflow-list-toggle')!.getBoundingClientRect()
    return { pageFits: document.documentElement.scrollWidth <= innerWidth,
      columnsFit: list.right <= detail.left && detail.right <= innerWidth,
      toggleVisible: toggle.right <= detail.right }
  }, screen)
  check(`${screen} fits 980 × 640`, narrow.pageFits && narrow.columnsFit && narrow.toggleVisible, JSON.stringify(narrow))
  await shot(page, 'narrow-dark')
} catch (error) {
  check(`proof reached ${screen}`, false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
finish(`PROOF ${screen.toUpperCase()} STYLE`)
