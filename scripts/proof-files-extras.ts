// U9 Files-extras gate, run against the PACKAGED app (npm run package first): `npm run proof:files-extras`.
// No agent usage. Your documents (kept in the app's folder, never the project), new-file kinds,
// pin / archive / rename, Open in default app / Reveal in Finder / Move to Trash, the open-tabs
// menu (Close other / Close all keep unsaved tabs), the Saved / words footer, and line numbers.
// Finder and the Trash are intercepted in the main process, so the real Trash stays untouched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const home = mkdtempSync(join(tmpdir(), 'cockpit-files-extras-proof-'))
const state = join(home, 'state')
const project = join(home, 'greenhouse')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# Greenhouse\n\nSeedlings go out in May.\n')
writeFileSync(join(project, 'notes.txt'), 'first line\nsecond line\nthird line\n')
writeFileSync(join(project, 'todo.txt'), 'repot the basil\n')

const docsDir = (): string => { const base = join(state, 'documents'); return join(base, readdirSync(base).find((n) => !n.endsWith('.json'))!) }
const list = (page: Page) => page.getByRole('navigation', { name: /Project files|Your documents/ })
const row = (page: Page, name: string) => list(page).locator('.file-row-wrap').filter({ has: page.locator('.file-row', { hasText: new RegExp(`^${name.replace('.', '\\.')}`) }) })
async function rowAction(page: Page, name: string, action: string): Promise<void> {
  await row(page, name).getByRole('button', { name: `More for ${name}` }).click()
  await page.getByRole('menuitem', { name: action }).click()
}
async function newFile(page: Page, kind: RegExp, name: string): Promise<void> {
  await list(page).getByRole('button', { name: 'New file' }).click()
  await page.getByRole('menuitem', { name: kind }).click()
  await page.getByLabel('New file name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
}
const editor = (page: Page) => page.getByLabel('File contents')

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)
await app.evaluate(({ shell }) => {
  const calls: string[] = []
  ;(globalThis as unknown as { calls: string[] }).calls = calls
  Object.assign(shell, {
    showItemInFolder(path: string) { calls.push(`reveal ${path}`) },
    openPath(path: string) { calls.push(`open ${path}`); return Promise.resolve('') },
    trashItem(path: string) { calls.push(`trash ${path}`); return Promise.resolve() },
  })
})
const calls = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { calls: string[] }).calls)

try {
  await openProject(page, project, 'Greenhouse')
  // Source view, so typing goes to the plain text box; read when the editor mounts.
  await page.evaluate(() => localStorage.setItem('cockpit:markdown-view', 'source'))
  await page.getByRole('tab', { name: 'Files', exact: true }).click()

  // Your documents.
  await page.getByRole('tab', { name: 'Your documents' }).click()
  await list(page).getByText('No documents yet.', { exact: false }).waitFor()
  await newFile(page, /^Markdown/, 'planting plan')
  await page.locator('.file-tab.active').filter({ hasText: 'planting plan.md' }).waitFor()
  check('Markdown adds .md, and the document opens', true)
  await editor(page).fill('Tomatoes in bed two, basil by the door.\nPeppers wait for June.')
  check('the footer counts words and says unsaved', await page.locator('.file-status').innerText().then((t) => /Unsaved changes/.test(t) && /12 words/.test(t) && /2 lines/.test(t)),
    await page.locator('.file-status').innerText())
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.file-status').filter({ hasText: /^Saved/ }).waitFor()
  check('saving says Saved', true)
  check('documents are kept by Cockpit, never in the project', readFileSync(join(docsDir(), 'planting plan.md'), 'utf8').startsWith('Tomatoes')
    && !existsSync(join(project, 'planting plan.md')))
  check('documents are not offered to conversations', await page.getByRole('button', { name: 'Add to conversation' }).count() === 0)
  await newFile(page, /^JSON/, 'sowing')
  await page.locator('.file-tab.active').filter({ hasText: 'sowing.json' }).waitFor()
  check('JSON starts as an empty object', readFileSync(join(docsDir(), 'sowing.json'), 'utf8') === '{\n}\n')
  await newFile(page, /^Plain text/, 'shopping')
  await page.locator('.file-tab.active').filter({ hasText: 'shopping.txt' }).waitFor()
  check('Plain text adds .txt', existsSync(join(docsDir(), 'shopping.txt')))

  await rowAction(page, 'shopping.txt', 'Pin')
  await page.locator('.file-pin').waitFor()
  const order = await list(page).locator('.file-row > span:first-of-type').allTextContents()
  check('a pinned document leads the list', order[0] === 'shopping.txt', order.join(', '))
  await rowAction(page, 'planting plan.md', 'Archive')
  await list(page).getByRole('tab', { name: /Archived 1/ }).waitFor()
  check('archiving moves it out of Current', await row(page, 'planting plan.md').count() === 0)
  await list(page).getByRole('tab', { name: /Archived/ }).click()
  await rowAction(page, 'planting plan.md', 'Unarchive')
  await list(page).getByText('Nothing archived.').waitFor()
  await list(page).getByRole('tab', { name: 'Current' }).click()
  check('Unarchive brings it back', await row(page, 'planting plan.md').count() === 1)

  await rowAction(page, 'sowing.json', 'Rename…')
  await page.getByLabel('New name for sowing.json').fill('seed order.json')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await row(page, 'seed order.json').waitFor()
  check('rename changes the file and its open tab', existsSync(join(docsDir(), 'seed order.json')) && !existsSync(join(docsDir(), 'sowing.json'))
    && await page.locator('.file-tab').filter({ hasText: 'seed order.json' }).count() === 1)
  await rowAction(page, 'shopping.txt', 'Rename…')
  await page.getByLabel('New name for shopping.txt').fill('seed order.json')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'seed order.json already exists' }).waitFor()
  check('rename never replaces another file', readFileSync(join(docsDir(), 'seed order.json'), 'utf8') === '{\n}\n' && existsSync(join(docsDir(), 'shopping.txt')))
  await page.getByLabel('New name for shopping.txt').press('Escape')

  await rowAction(page, 'planting plan.md', 'Reveal in Finder')
  await rowAction(page, 'planting plan.md', 'Open in default app')
  await page.waitForTimeout(300)
  const external = await calls()
  check('Reveal in Finder and Open in default app name the document on disk',
    external[0] === `reveal ${realpathSync(join(docsDir(), 'planting plan.md'))}` && external[1] === `open ${realpathSync(join(docsDir(), 'planting plan.md'))}`)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-files-documents.png') })

  // Project files: rename and Move to Trash.
  await page.getByRole('tab', { name: 'Project files' }).click()
  await rowAction(page, 'todo.txt', 'Rename…')
  await page.getByLabel('New name for todo.txt').fill('jobs.txt')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await row(page, 'jobs.txt').waitFor()
  check('project files can be renamed in place', existsSync(join(project, 'jobs.txt')) && !existsSync(join(project, 'todo.txt')))
  await row(page, 'jobs.txt').locator('.file-row').click()
  await page.locator('.file-tab.active').filter({ hasText: 'jobs.txt' }).waitFor()
  const jobs = realpathSync(join(project, 'jobs.txt'))
  await rowAction(page, 'jobs.txt', 'Move to Trash…')
  await page.getByRole('alertdialog', { name: 'Move jobs.txt to the Trash' }).getByRole('button', { name: 'Move to Trash' }).click()
  await page.locator('.file-tab').filter({ hasText: 'jobs.txt' }).waitFor({ state: 'detached' })
  check('Move to Trash sends the file to the Trash and closes its tab', (await calls()).includes(`trash ${jobs}`))
  rmSync(join(project, 'jobs.txt')) // the intercepted Trash did not move it
  await page.getByRole('tab', { name: 'Your documents' }).click()
  await page.getByRole('tab', { name: 'Project files' }).click()
  await row(page, 'notes.txt').waitFor()

  // Line numbers, then the open-tabs menu.
  await row(page, 'notes.txt').locator('.file-row').click()
  await page.locator('.file-tab.active').filter({ hasText: 'notes.txt' }).waitFor()
  check('Source view numbers the lines', (await page.locator('.file-gutter').innerText()).trim() === '1\n2\n3\n4')
  await row(page, 'README.md').locator('.file-row').click()
  await page.locator('.file-tab.active').filter({ hasText: 'README.md' }).waitFor()
  await editor(page).fill('# Greenhouse\n\nSeedlings go out in late May.\n')
  await page.locator('.file-tab').filter({ hasText: 'notes.txt' }).getByRole('tab').click()
  const tabsBefore = await page.locator('.file-tab').count()
  await page.getByRole('button', { name: 'Open tabs' }).click()
  const listed = await page.getByRole('menu', { name: 'Open tabs' }).getByRole('menuitemradio').count()
  await page.getByRole('menuitem', { name: 'Close other tabs' }).click()
  const left = await page.locator('.file-tab').allInnerTexts()
  check('the tabs menu lists every open tab', listed === tabsBefore, `${listed} of ${tabsBefore}`)
  check('Close other tabs keeps the active one and any with unsaved changes', left.length === 2 && left.some((t) => t.includes('notes.txt')) && left.some((t) => t.includes('README.md')),
    left.join(' | '))
  check('it says why a tab stayed open', await page.getByText('1 tab has unsaved changes and stayed open.').isVisible())
  await page.screenshot({ path: join(PROOF_DIR, 'proof-files-tabs.png') })
  await page.getByRole('button', { name: 'Open tabs' }).click()
  await page.getByRole('menuitem', { name: 'Close all tabs' }).click()
  const remaining = await page.locator('.file-tab').allInnerTexts()
  check('Close all tabs leaves only unsaved work', remaining.length === 1 && remaining[0]!.includes('README.md'), remaining.join(' | '))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-files-extras-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF FILES EXTRAS')
