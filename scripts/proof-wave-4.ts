// Packaged gate for parity wave 4 (files, documents, workflows). Seeded projects and files,
// no agent runs, no network. Moving to the Trash is stubbed in main to a plain delete of the
// temporary file, so a proof run never fills the real Trash.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-4
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave4-proof-'))
const project = join(root, 'app')
const other = join(root, 'other')
mkdirSync(join(project, 'src', 'components'), { recursive: true })
mkdirSync(other)
writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 2\n')
writeFileSync(join(project, 'src', 'c.ts'), 'export const c = 3\n')
writeFileSync(join(project, 'src', 'components', 'x.ts'), 'export const x = 0\n')
writeFileSync(join(project, 'README.md'), '# App\n')
writeFileSync(join(other, 'notes.txt'), 'other\n')

const store = createThreadStore(join(root, 'state'))
const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave4-${name}.png`) })
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await app.evaluate(({ shell }) => {
    const fs = (process as unknown as { mainModule: { require(id: string): typeof import('node:fs') } }).mainModule.require('node:fs')
    shell.trashItem = async (path: string) => { fs.rmSync(path) }
  })
  await apiPost(page, '/api/projects', { path: other, pinned: false, name: 'Other' })
  await openProject(page, project, 'App')

  // F1: remove a project from its row in the Projects menu.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Projects' })
  const otherRow = menu.locator('.project-row').filter({ hasText: 'Other' })
  await otherRow.hover()
  await otherRow.getByRole('button', { name: 'Remove Other from Cockpit' }).click()
  const confirm = menu.getByRole('alertdialog', { name: 'Remove Other from Cockpit' })
  check('F1 the row asks before removing', await confirm.isVisible())
  await shot(page, 'f1-remove-confirm')
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
  check('F1 the project leaves the menu', await until('gone', async () => (await menu.locator('.project-row').filter({ hasText: 'Other' }).count()) === 0))
  check('F1 the folder is untouched and you stay in the open project', existsSync(join(other, 'notes.txt'))
    && (await page.getByRole('tab', { selected: true }).first().innerText()).includes('App'))
  await page.keyboard.press('Escape')

  // F4: Home, Back, Forward and Up in Files.
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Files/ }).click()
  const explorer = page.getByRole('navigation', { name: 'Project files' })
  const where = explorer.locator('.file-path')
  const nav = (name: string) => explorer.getByRole('group', { name: 'Folder navigation' }).getByRole('button', { name, exact: true })
  check('F4 Back, Forward, Home and Up start disabled at the top', await nav('Back').isDisabled() && await nav('Forward').isDisabled() && await nav('Home').isDisabled() && await nav('Up').isDisabled())
  await explorer.locator('.file-row').filter({ hasText: /^src/ }).click()
  await explorer.locator('.file-row').filter({ hasText: /^components/ }).click()
  check('F4 folders open inside each other', await until('components', async () => (await where.innerText()) === 'src/components'))
  await nav('Back').click()
  check('F4 Back returns to the previous folder', await until('back', async () => (await where.innerText()) === 'src'))
  await nav('Forward').click()
  check('F4 Forward goes there again', await until('forward', async () => (await where.innerText()) === 'src/components'))
  await nav('Up').click()
  check('F4 Up opens the enclosing folder', await until('up', async () => (await where.innerText()) === 'src'))
  await nav('Home').click()
  check('F4 Home goes to the project top', await until('home', async () => (await where.innerText()) === '/'))
  await nav('Back').click()
  check('F4 Back works after Home', await until('back again', async () => (await where.innerText()) === 'src'))

  // F2: rename with the name and extension apart.
  const row = (name: string) => explorer.locator('.file-row-wrap').filter({ has: page.locator('.file-row', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) })
  await row('b.ts').getByRole('button', { name: 'More for b.ts' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const stem = explorer.getByRole('textbox', { name: 'New name for b.ts' })
  const ext = explorer.getByRole('textbox', { name: 'Extension for b.ts' })
  check('F2 the name and extension are separate fields', (await stem.inputValue()) === 'b' && (await ext.inputValue()) === 'ts')
  check('F2 the name is selected, ready to type over', await stem.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === 1 && document.activeElement === el))
  const [stemBox, extBox] = [await stem.boundingBox(), await ext.boundingBox()]
  check('F2 the name field takes the room and the extension sits right after it', !!stemBox && !!extBox && stemBox.width > extBox.width * 2 && extBox.x - (stemBox.x + stemBox.width) < 24,
    `${stemBox?.width} / ${extBox?.width}, gap ${extBox && stemBox ? extBox.x - (stemBox.x + stemBox.width) : '?'}`)
  await shot(page, 'f2-rename')
  await stem.fill('beta')
  await ext.fill('.md')
  await ext.press('Enter')
  check('F2 renaming joins them, a typed dot included', await until('renamed', async () => existsSync(join(project, 'src', 'beta.md')) && !existsSync(join(project, 'src', 'b.ts'))))
  check('F2 the list shows the new name', await until('row', async () => (await row('beta.md').count()) === 1))

  // F3: moving the open file to the Trash shows the next one in the folder.
  await explorer.locator('.file-row', { hasText: /^a\.ts$/ }).click()
  const activeTab = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { selected: true })
  await until('a.ts open', async () => (await activeTab.innerText()).startsWith('a.ts'))
  await row('a.ts').getByRole('button', { name: 'More for a.ts' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click()
  await row('a.ts').getByRole('alertdialog').getByRole('button', { name: 'Move to Trash' }).click()
  check('F3 the file is gone', await until('trashed', async () => !existsSync(join(project, 'src', 'a.ts'))))
  check('F3 the next file in the folder is shown', await until('next', async () => (await activeTab.innerText()).startsWith('beta.md')), await activeTab.innerText().catch(() => ''))
  await shot(page, 'f3-next-file')

  // F7: hide the explorer for more room; it stays hidden after a reload.
  const editor = page.locator('.file-editor')
  const wide = (await editor.boundingBox())?.width ?? 0
  await page.getByRole('button', { name: 'Hide files' }).click()
  check('F7 hiding the explorer gives the editor the width', await until('hidden', async () => !(await explorer.isVisible()) && ((await editor.boundingBox())?.width ?? 0) > wide + 150))
  await shot(page, 'f7-hidden')
  await page.reload()
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Files/ }).click()
  check('F7 it stays hidden after a reload', await until('still hidden', async () => (await page.getByRole('button', { name: 'Show files' }).isVisible()) && !(await explorer.isVisible())))
  await page.getByRole('button', { name: 'Show files' }).click()
  check('F7 Show files brings it back', await until('shown', async () => explorer.isVisible()))
  await setTheme(page, 'Dark')
  await shot(page, 'files-dark')
  await setTheme(page, 'Light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  check('F4 the folder buttons fit the narrow explorer', await explorer.locator('.file-location').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  await shot(page, 'files-narrow')
} finally {
  await app.close()
}
finish('PROOF WAVE 4')
