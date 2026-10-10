// Conversation-screen visual proof against the packaged Electron app. The store and HOME are
// disposable; the stand-in login shell and agent path cannot discover David's Homebrew CLIs.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:conversation-style
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-conversation-style-'))
const home = join(root, 'home'), project = join(root, 'garden')
mkdirSync(home)
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# Garden\n')
mkdirSync(PROOF_DIR, { recursive: true })
const store = createThreadStore(join(root, 'state'))
const settings = threadSettingsSchema.parse({})
let clock = Date.now() - 5 * 60_000
const seed = (title: string, events: NormalizedEvent[], completed = false): string => {
  const createdAt = new Date(clock).toISOString()
  const id = randomUUID()
  store.create({ id, title, projectPath: project, settings, sessionId: randomUUID(), sessionStarted: false,
    completed, createdAt, updatedAt: createdAt })
  for (const event of events) store.append(id, event, new Date((clock += 1_000)).toISOString())
  clock += 60_000
  return id
}
const reply = (text: string): NormalizedEvent => ({ kind: 'assistant_text', messageId: randomUUID(), text })
const done: NormalizedEvent = { kind: 'result', ok: true }
seed('Review migration notes', [{ kind: 'user_text', text: 'Review the migration notes.' }, { kind: 'error', message: 'The local stand-in stopped before replying.' }])
seed('Summarize the release checklist', [
  { kind: 'user_text', text: 'Summarize the release checklist.' }, reply('The checklist is ready for review.'), done,
], true)
seed('Conversation layout review', [
  { kind: 'user_text', text: 'Review the conversation screen at desktop and narrow window sizes. Keep the agent glyphs and the working light.' },
  reply('The conversation list has flat rows and a filled selection. Filters remain compact, and each status stays at the right edge of its row.\n\nThe transcript has a calmer reading rhythm, with the composer anchored beneath it. The project keeps its green accent.'), done,
  { kind: 'user_text', text: 'Check the header and the 980 × 640 layout too.' },
  reply('The list toggle sits beside the title. Status and completion appear together below it, and the narrow layout keeps the message box visible.'), done,
])
seed('Check the working light', [{ kind: 'user_text', text: 'Check the working light timing.' }, reply('The working light drifts only while a turn runs.'), done])

const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `conversation-enjoy-${name}.png`) })
const app = await launchPackagedApp({ HOME: home, SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'),
  COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') }, ['--use-mock-keychain'])
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1360, height: 860 })
  await openProject(page, project, 'Garden')
  await apiPost(page, '/api/projects', { path: project, color: 'green' })
  await page.reload()
  await page.locator('.card').filter({ hasText: 'Conversation layout review' }).click()
  await page.getByRole('heading', { name: 'Conversation layout review' }).waitFor()
  check('selected synthetic conversation is visible', await page.locator('.card.selected').count() === 1 && await page.locator('.bubble').count() >= 4)
  check('the green project tint is active', await page.locator('.app.tint-green').count() === 1)
  await page.getByRole('button', { name: 'Hide conversation list' }).click()
  const hidden = await page.locator('.layout.list-hidden').count() === 1 && await page.getByRole('button', { name: 'Show conversation list' }).count() === 1
  await page.getByRole('button', { name: 'Show conversation list' }).click()
  check('the square title toggle hides and restores the list', hidden && await page.locator('.layout.list-hidden').count() === 0)
  check('the list header has no duplicate toggle', await page.locator('.list-head .list-toggle').count() === 0)
  await page.keyboard.press('Meta+Backslash')
  const shortcutHidden = await page.locator('.layout.list-hidden').count() === 1
  await page.keyboard.press('Meta+Backslash')
  check('⌘\\ hides and restores the list', shortcutHidden && await page.locator('.layout.list-hidden').count() === 0)
  const selectedStyle = await page.locator('.card.selected').evaluate((el) => {
    const style = getComputedStyle(el)
    return { border: style.borderWidth, shadow: style.boxShadow, fill: style.backgroundColor }
  })
  // Lumen: the selected row is lifted onto paper (a soft shadow, no border) with a selected-colour mark at its edge.
  const selectedMark = await page.locator('.card.selected').evaluate((el) => getComputedStyle(el, '::before').width)
  check('selected row is lifted onto paper, without a border, with its edge mark', selectedStyle.border === '0px' && selectedStyle.shadow !== 'none' && selectedStyle.fill !== 'rgba(0, 0, 0, 0)' && selectedMark === '2px', JSON.stringify({ ...selectedStyle, selectedMark }))
  check('handoff review styles survived the parked commit', await page.evaluate(() => {
    return [...document.styleSheets].some((sheet) => {
      try { return [...sheet.cssRules].some((rule) => rule.cssText.includes('.handoff-review')) } catch { return false }
    })
  }))
  await setTheme(page, 'Light')
  await shot(page, 'light')
  await setTheme(page, 'Dark')
  await shot(page, 'dark')
  await page.setViewportSize({ width: 980, height: 640 })
  const narrow = await page.evaluate(() => {
    const filters = document.querySelector('.filters')!
    const list = document.querySelector('.list')!.getBoundingClientRect()
    const listToggle = document.querySelector('.thread-list-toggle')!.getBoundingClientRect()
    const newButton = document.querySelector('.new-button')!.getBoundingClientRect()
    const thread = document.querySelector('.thread')!.getBoundingClientRect()
    const composer = document.querySelector('.composer-card')!.getBoundingClientRect()
    return { pageFits: document.documentElement.scrollWidth <= innerWidth,
      listFits: list.right <= thread.left && listToggle.left >= thread.left && newButton.right <= list.right,
      filtersFit: filters.scrollWidth <= filters.clientWidth,
      composerVisible: composer.bottom <= innerHeight }
  })
  check('980 × 640 keeps the list, filters, and composer in view', narrow.pageFits && narrow.listFits && narrow.filtersFit && narrow.composerVisible, JSON.stringify(narrow))
  await shot(page, 'narrow-dark')
} catch (error) {
  check('proof reached the conversation screen', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
finish('PROOF CONVERSATION STYLE')
