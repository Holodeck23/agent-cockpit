// Checkpoint 6 gate: the composer's context picker in the PACKAGED app (npm run package first).
// Synthetic project, no agent runs: sends are intercepted and checked, never delivered.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { apiPost, messageBox, openProject } from './lib/ui.ts'

const { check, finish } = checker()
const project = join(mkdtempSync(join(tmpdir(), 'cockpit-context-')), 'bakery-site')
mkdirSync(join(project, 'src', 'pages'), { recursive: true })
mkdirSync(join(project, 'node_modules', 'lib'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Bakery site\n')
writeFileSync(join(project, 'src', 'pages', 'opening hours.tsx'), 'export {}\n')
writeFileSync(join(project, 'src', 'pages', 'menu.tsx'), 'export {}\n')
writeFileSync(join(project, 'node_modules', 'lib', 'hours.js'), 'x')
for (let i = 0; i < 9; i += 1) writeFileSync(join(project, `note-${i}.md`), `note ${i}\n`)

const picker = (page: Page) => page.getByRole('dialog', { name: 'Add context' })
async function openPicker(page: Page, query: string): Promise<void> {
  if (!(await picker(page).isVisible())) await page.getByRole('button', { name: 'Add context', exact: true }).click()
  await picker(page).getByLabel('Search files and workflows').fill(query)
}
async function waitFor(page: Page, what: string, test: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await test()) return true; await page.waitForTimeout(150) }
  console.log(`  (timed out waiting for ${what})`)
  return false
}
const chips = (page: Page) => page.getByRole('list', { name: 'Attached to this message' }).getByRole('listitem')

const app = await launchPackagedApp()
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Bakery site')
  await apiPost(page, '/api/workflows', { projectPath: project, name: 'release-check', title: 'Release check', prompt: 'Check the release.' })
  await messageBox(page).fill('Tidy the opening hours page')

  await openPicker(page, 'hours')
  const rows = picker(page).getByRole('option')
  check('search finds files by any part of the path, and not in dependencies', await waitFor(page, 'the search', async () =>
    (await rows.count()) === 1 && ((await rows.first().textContent()) ?? '').includes('opening hours.tsx')))
  await page.keyboard.press('Enter')
  check('Enter adds the file as a chip and leaves the words alone', await waitFor(page, 'the chip', async () => (await chips(page).count()) === 1)
    && (await messageBox(page).inputValue()) === 'Tidy the opening hours page @file:src%2Fpages%2Fopening%20hours.tsx ')

  await openPicker(page, 'release')
  await waitFor(page, 'the workflow row', async () => (await rows.filter({ hasText: 'Release check' }).count()) === 1)
  await rows.filter({ hasText: 'Release check' }).click()
  check('workflows come from the same picker', await waitFor(page, 'two chips', async () => (await chips(page).count()) === 2))

  await openPicker(page, 'hours')
  await waitFor(page, 'the result', async () => (await rows.count()) === 1)
  check('something already added is shown as Added and cannot be added twice', (await rows.first().isDisabled()) && ((await rows.first().textContent()) ?? '').includes('Added'))
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-6-context.png') })

  // Typed by hand, a duplicate is marked; removing a chip takes out every copy.
  await messageBox(page).fill(`${await messageBox(page).inputValue()}and again @file:src%2Fpages%2Fopening%20hours.tsx `)
  check('a duplicate reference is marked on its chip', await waitFor(page, 'the duplicate mark', async () => (await page.getByText('added 2×').count()) === 1))
  await page.getByRole('button', { name: 'Remove opening hours.tsx', exact: true }).click()
  check('removing a chip removes every copy from the draft', !(await messageBox(page).inputValue()).includes('@file:') && (await chips(page).count()) === 1)

  // A reference that would fail turns red before sending, and sending still fails visibly.
  await messageBox(page).fill('Read @file:gone.md please')
  check('a missing file turns its chip red before sending', await waitFor(page, 'the broken chip', async () => (await page.locator('.reference-chip.broken').count()) === 1))
  await openPicker(page, 'menu')
  await waitFor(page, 'the menu file', async () => (await rows.count()) === 1 && ((await rows.first().textContent()) ?? '').includes('menu'))
  await page.keyboard.press('Enter')
  rmSync(join(project, 'src', 'pages', 'menu.tsx'))
  check('a file deleted after it was added turns red too', await waitFor(page, 'two broken chips', async () => (await page.locator('.reference-chip.broken').count()) === 2))
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  check('sending with a missing file keeps the draft and says why', await waitFor(page, 'the send error', async () =>
    (await page.locator('.composer [role="alert"]').filter({ hasText: 'Not found in this project' }).count()) === 1) && (await messageBox(page).inputValue()).includes('@file:gone.md'))

  // The attachment limit is the server's: at most 8 files.
  await messageBox(page).fill('')
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click().catch(() => undefined)
  for (let i = 0; i < 8; i += 1) {
    await openPicker(page, `note-${i}`)
    await waitFor(page, `note-${i}`, async () => (await rows.count()) === 1 && ((await rows.first().textContent()) ?? '').includes(`note-${i}`))
    await page.keyboard.press('Enter')
  }
  await openPicker(page, 'note-8')
  await waitFor(page, 'note-8', async () => (await rows.count()) === 1 && ((await rows.first().textContent()) ?? '').includes('note-8'))
  check('after 8 files the picker says the limit is reached', (await rows.first().isDisabled()) && ((await rows.first().textContent()) ?? '').includes('Limit reached'))
  await page.keyboard.press('Escape')
  check('eight chips, no more', (await chips(page).count()) === 8)

  await page.setViewportSize({ width: 980, height: 720 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  await openPicker(page, 'page')
  await waitFor(page, 'the results', async () => (await rows.count()) > 0)
  check('an edit clears the earlier send error', (await page.locator('.composer [role="alert"]').count()) === 0)
  check('no horizontal page scroll at minimum desktop width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-6-context-dark.png') })
} finally {
  await app.close()
}
finish('CHECKPOINT 6')
