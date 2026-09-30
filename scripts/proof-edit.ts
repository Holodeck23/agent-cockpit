// Checkpoint 5a gate: editing text files in the Files panel of the PACKAGED app (npm run package first).
// Synthetic project, no agent runs. Covers save, conflicts with changes made on disk, protected
// drafts, line endings, read-only files and new files.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const project = join(mkdtempSync(join(tmpdir(), 'cockpit-edit-')), 'garden-notes')
mkdirSync(join(project, 'docs'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Garden notes\n\nWater the tomatoes on Mondays.\n')
writeFileSync(join(project, 'windows.txt'), 'first line\r\nsecond line\r\n')
writeFileSync(join(project, 'mixed.txt'), 'unix line\nwindows line\r\n')
const disk = (name: string): string => readFileSync(join(project, name), 'utf8')

const editor = (page: Page) => page.getByLabel('File contents')
async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.file-row').filter({ hasText: name }).first().click()
  await page.locator('.file-tab.active').filter({ hasText: name }).waitFor()
}
async function waitFor(page: Page, what: string, test: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await test()) return true
    await page.waitForTimeout(150)
  }
  console.log(`  (timed out waiting for ${what})`)
  return false
}

const app = await launchPackagedApp()
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Garden notes')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()

  // Edit and save with the keyboard.
  await openFile(page, 'README.md')
  await editor(page).fill('# Garden notes\n\nWater the tomatoes on Mondays and Thursdays.\n')
  check('an edit marks the tab unsaved', await page.locator('.file-tab.active .file-dirty').isVisible())
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-5a-editor.png') })
  await editor(page).press('Meta+s')
  check('Cmd+S saves to disk', await waitFor(page, 'the save', () => disk('README.md').includes('Thursdays')))
  check('the tab reads Saved afterwards', await waitFor(page, 'Saved', async () => (await page.locator('.file-editor header span').textContent()) === 'Saved'))

  // A change made on disk meanwhile is never overwritten silently.
  writeFileSync(join(project, 'README.md'), '# Garden notes\n\nThe agent rewrote this line.\n')
  await editor(page).fill('# Garden notes\n\nMy own edit.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'changed on disk' }).waitFor()
  check('saving over a disk change shows a conflict instead', disk('README.md').includes('The agent rewrote'))
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  check('Reload from disk shows the new text and drops the draft',
    await waitFor(page, 'the reload', async () => (await editor(page).inputValue()).includes('The agent rewrote') && !(await page.locator('.file-tab.active .file-dirty').count())))

  writeFileSync(join(project, 'README.md'), '# Garden notes\n\nChanged again on disk.\n')
  await editor(page).fill('# Garden notes\n\nKeep mine.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Overwrite with mine', exact: true }).click()
  check('Overwrite with mine is an explicit choice that saves the draft', await waitFor(page, 'the overwrite', () => disk('README.md').includes('Keep mine')))

  writeFileSync(join(project, 'README.md'), '# Garden notes\n\nKeep mine.\nThe agent added a line.\n')
  await editor(page).fill('# Garden notes\n\nKeep mine, and my new line.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Save mine as a copy', exact: true }).click()
  check('Save mine as a copy keeps both versions', await waitFor(page, 'the copy', () => {
    try { return disk('README (copy).md').includes('my new line') && disk('README.md').includes('The agent added a line') } catch { return false }
  }))
  check('the copy opens in its own tab', await waitFor(page, 'the copy tab', async () => (await page.locator('.file-tab.active').filter({ hasText: 'README (copy).md' }).count()) > 0))
  await page.getByRole('button', { name: 'Close README (copy).md', exact: true }).click()
  await page.getByRole('tab', { name: 'README.md' }).click()
  await page.locator('.file-tab.active').filter({ hasText: 'README.md' }).waitFor()
  writeFileSync(join(project, 'README.md'), '# Garden notes\n\nKeep mine.\n')
  await page.getByRole('tab', { name: 'README.md' }).click()
  await waitFor(page, 'the refreshed file', async () => (await editor(page).inputValue()).trim().endsWith('Keep mine.'))

  // Unsaved drafts are protected: closing asks, and leaving the panel or reloading keeps them.
  await editor(page).fill('# Garden notes\n\nA draft worth keeping.\n')
  await page.getByRole('button', { name: 'Close README.md', exact: true }).click()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  check('closing an unsaved tab asks first', (await editor(page).inputValue()).includes('A draft worth keeping'))
  await page.getByRole('tab', { name: /^Conversations/ }).click()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  check('the draft survives leaving the Files panel', await waitFor(page, 'the restored draft', async () => (await editor(page).count()) > 0 && (await editor(page).inputValue()).includes('A draft worth keeping')))
  await page.reload()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  check('the draft survives a reload', await waitFor(page, 'the draft after reload', async () => (await editor(page).count()) > 0 && (await editor(page).inputValue()).includes('A draft worth keeping')))
  check('the disk still has the last saved text', disk('README.md').includes('Keep mine'))
  await page.getByRole('button', { name: 'Close README.md', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  check('Discard closes the tab without saving', (await page.locator('.file-tab').count()) === 0 && disk('README.md').includes('Keep mine'))

  // Line endings stay as they were; a file that mixes them is read-only.
  await openFile(page, 'windows.txt')
  await editor(page).fill('first line\nsecond line\nthird line\n')
  await editor(page).press('Meta+s')
  check('a Windows file keeps CRLF line endings', await waitFor(page, 'the CRLF save', () => disk('windows.txt') === 'first line\r\nsecond line\r\nthird line\r\n'))
  await openFile(page, 'mixed.txt')
  check('a file with mixed line endings is read-only', (await editor(page).getAttribute('readonly')) !== null && await page.getByRole('button', { name: 'Save', exact: true }).isDisabled())

  // New files go in the folder being shown and never replace an existing one.
  await page.locator('.file-row').filter({ hasText: 'docs' }).click()
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByLabel('New file name').fill('planting.md')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.locator('.file-tab.active').filter({ hasText: 'planting.md' }).waitFor()
  check('New file creates an empty file in the current folder', disk('docs/planting.md') === '')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByLabel('New file name').fill('planting.md')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  check('creating an existing name is refused', await waitFor(page, 'the refusal', async () => (await page.getByRole('alert').filter({ hasText: 'already exists' }).count()) > 0))

  // Narrow window and dark mode.
  await page.setViewportSize({ width: 980, height: 720 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  check('no horizontal page scroll at minimum desktop width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-5a-editor-dark.png') })
} finally {
  await app.close()
}
finish('CHECKPOINT 5A')
