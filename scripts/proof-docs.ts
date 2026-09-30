// Checkpoint 5b gate: the Document view of Markdown files in the PACKAGED app (npm run package first).
// Synthetic files, no agent runs. Every save is compared byte for byte with the expected file:
// only what was edited may change.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const NOTES = `---
title: Garden
---
# Garden notes

* water on *Mondays*
* prune the roses

- [ ] Order seeds
- [x] Clean the shed

| Plant | Days |
| --- | --- |
| Tomato | 2 |

<!-- keep this comment -->

---

\`\`\`text
alpha <beta>
\`\`\`

Visit [the allotment site](https://example.com) weekly.
`
const project = join(mkdtempSync(join(tmpdir(), 'cockpit-docs-')), 'garden-docs')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'notes.md'), NOTES)
writeFileSync(join(project, 'mixed.md'), '# Mixed\nunix line\r\nwindows line\n')
const disk = (name: string): string => readFileSync(join(project, name), 'utf8')
const surface = (page: Page) => page.locator('.doc-surface .ProseMirror')

async function waitFor(page: Page, what: string, test: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await test()) return true
    await page.waitForTimeout(150)
  }
  console.log(`  (timed out waiting for ${what})`)
  return false
}
async function save(page: Page): Promise<void> {
  await surface(page).press('Meta+s')
}

const app = await launchPackagedApp()
try {
  const page = await app.firstWindow()
  page.on('console', (m) => { if (m.text().includes('[cockpit]')) console.log('CONSOLE', m.text().slice(0, 400)) })
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Garden docs')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'notes.md' }).click()
  await surface(page).waitFor()
  check('a Markdown file opens as a document', await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Document' }).getAttribute('aria-pressed') === 'true')
  check('tables and to-do items render', (await surface(page).locator('table').count()) === 1 && (await surface(page).locator("li[data-item-type='task']").count()) === 2)
  check('front matter is kept out of the document and said so', (await page.getByText('Front matter is kept as it is').count()) === 1 && !(await surface(page).innerText()).includes('title: Garden'))

  // Undo right after opening must not empty the document.
  await surface(page).click()
  await surface(page).press('Meta+z')
  check('undo after opening leaves the document as it was', (await surface(page).innerText()).includes('Garden notes') && (await page.locator('.file-tab.active .file-dirty').count()) === 0)

  // Ticking a to-do changes exactly one line on disk.
  const task = surface(page).locator("li[data-item-type='task']").first()
  const box = (await task.boundingBox())!
  await page.mouse.click(box.x + 8, box.y + 10)
  check('ticking a to-do marks the file unsaved', await waitFor(page, 'the dirty marker', async () => (await page.locator('.file-tab.active .file-dirty').count()) === 1))
  await save(page)
  check('saving writes only that line', await waitFor(page, 'the task save', () => disk('notes.md') === NOTES.replace('- [ ] Order seeds', '- [x] Order seeds')))

  // Bold one word from the toolbar; everything else stays byte for byte.
  await surface(page).getByText('prune the roses').dblclick({ position: { x: 5, y: 5 } })
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click()
  await save(page)
  const bolded = NOTES.replace('- [ ] Order seeds', '- [x] Order seeds').replace('* prune the roses', '* **prune** the roses')
  check('bold changes only the edited list and keeps its * bullets', await waitFor(page, 'the bold save', () => disk('notes.md') === bolded), JSON.stringify(disk('notes.md').split('\n').slice(4, 7)))
  check('comment, table, rule, fence, link and front matter are untouched', ['<!-- keep this comment -->', '| --- | --- |', '\n---\n\n```text', '[the allotment site](https://example.com)', 'title: Garden'].every((part) => disk('notes.md').includes(part)))
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-5b-document.png') })

  // Source and Document edit the same draft.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Source', exact: true }).click()
  const source = page.getByLabel('File contents')
  check('Source shows the Markdown the document wrote', (await source.inputValue()).includes('* **prune** the roses'))
  await source.fill((await source.inputValue()).replace('weekly.', 'every week.'))
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Document', exact: true }).click()
  check('a Source edit shows in the document', await waitFor(page, 'the document text', async () => (await surface(page).innerText()).includes('every week.')))
  await save(page)
  check('and saves as typed', await waitFor(page, 'the source save', () => disk('notes.md') === bolded.replace('weekly.', 'every week.')))

  // A change on disk still produces a conflict in the Document view.
  writeFileSync(join(project, 'notes.md'), `${disk('notes.md')}\nAdded by the agent.\n`)
  const again = (await surface(page).locator("li[data-item-type='task']").first().boundingBox())!
  await page.mouse.click(again.x + 8, again.y + 10)
  await save(page)
  check('a disk change shows the conflict choices', await waitFor(page, 'the conflict', async () => (await page.getByRole('button', { name: 'Save mine as a copy' }).count()) === 1))
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  check('Reload from disk shows the agent\'s line', await waitFor(page, 'the reloaded document', async () => (await surface(page).innerText()).includes('Added by the agent.')))

  // A file with mixed line endings can be read but not edited.
  await page.locator('.file-row').filter({ hasText: 'mixed.md' }).click()
  check('mixed line endings make the document read-only', await waitFor(page, 'the read-only document', async () => (await surface(page).getAttribute('contenteditable')) === 'false'))

  await page.setViewportSize({ width: 980, height: 720 })
  await page.locator('.file-tab').filter({ hasText: 'notes.md' }).getByRole('tab').click()
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  check('no horizontal page scroll at minimum desktop width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-5b-document-dark.png') })
} finally {
  await app.close()
}
finish('CHECKPOINT 5B')
