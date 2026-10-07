// Packaged gate for route Day 13 (a safe handoff path): before switching agents the user sees the
// exact context that will be sent, then starts the handoff, and the receiving agent gets exactly
// that text. Stand-ins only: Claude is scripts/fixtures/echo-agent, Codex is
// scripts/fixtures/handoff-agent, which writes the instructions it was started with to a file.
// No provider usage, no real CLI: the app gets a throwaway HOME and the stand-in login shell.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:handoff
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { COCKPIT_GUIDANCE } from '../server/mcp/sessions.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, messageBox, openProject, setTheme, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-handoff-proof-'))
const home = join(root, 'home'), state = join(root, 'state'), project = join(root, 'parser')
const received = join(root, 'received-handoff.txt')
for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, 'README.md'), '# parser\n')
mkdirSync(PROOF_DIR, { recursive: true })

async function until(label: string, test: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `handoff-${name}.png`) })
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Agent settings' })
const review = (page: Page): Locator => picker(page).getByRole('group', { name: 'Handoff' })
const shownText = async (page: Page): Promise<string> => (await review(page).getByLabel('Handoff text').textContent()) ?? ''
const replies = (page: Page, text: RegExp): Locator => page.locator('.bubble').filter({ hasText: text })
async function send(page: Page, text: string, doneCount: number): Promise<void> {
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await until(`reply ${doneCount}`, async () => (await replies(page, /^Done\.$/).count()) === doneCount)
}
async function openReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await picker(page).getByRole('radio', { name: 'Codex', exact: true }).click()
  await picker(page).getByRole('button', { name: 'Switch…', exact: true }).click()
  await review(page).getByLabel('Handoff text').waitFor()
}

let app: ElectronApplication | undefined
try {
  app = await launchPackagedApp({
    HOME: home, SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'), COCKPIT_HOME: state,
    COCKPIT_AGENT_PATH: [join(ROOT, 'scripts/fixtures/echo-agent'), join(ROOT, 'scripts/fixtures/handoff-agent')].join(':'),
    COCKPIT_PROOF_HANDOFF_OUT: received,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Parser')

  // A conversation with Claude worth handing over.
  await startConversation(page, 'D13-OPENING port the parser to Rust')
  await until('first reply', async () => (await replies(page, /^Done\.$/).count()) === 1)
  await send(page, 'D13-SECOND keep the lexer tests green', 2)
  const threadId = await page.evaluate(async () => {
    const res = await fetch('/api/threads')
    const body = await res.json() as { data: Array<{ meta: { id: string; title: string } }> }
    return body.data.find((t) => t.meta.title.startsWith('D13-OPENING'))?.meta.id ?? ''
  })

  // 1. Switch… shows the handoff before anything is sent.
  await openReview(page)
  const first = await shownText(page)
  check('1 the picker shows what Codex receives before switching', (await review(page).getByText('What Codex receives').count()) === 1)
  check('1 the shown context has both messages', first.includes('USER: D13-OPENING port the parser to Rust') && first.includes('USER: D13-SECOND keep the lexer tests green'), first.slice(0, 200))
  const size = (await review(page).locator('.handoff-size').textContent()) ?? ''
  check('1 it says its size and that nothing was left out', size === `${first.length.toLocaleString('en')} characters · the whole conversation`, size)
  check('1 nothing has switched yet', !existsSync(received) && (await page.getByRole('button', { name: 'Agent settings' }).textContent())?.includes('Claude Code') === true)
  await shot(page, 'preview-light')

  // 2. Back returns to the settings without switching.
  await review(page).getByRole('button', { name: 'Back' }).click()
  check('2 Back returns to the settings', (await picker(page).getByRole('button', { name: 'Switch…', exact: true }).count()) === 1 && (await review(page).count()) === 0)

  // D14. A CLI that is not installed (Antigravity has no stand-in here): the handoff says so before the
  // switch, in plain words, and going back changes nothing.
  await picker(page).getByRole('radio', { name: /^Antigravity/ }).click()
  await picker(page).getByRole('button', { name: 'Switch…', exact: true }).click()
  const missing = review(page).getByRole('note')
  check('D14 switching to a CLI that is not installed says so before anything is sent',
    await until('missing note', async () => /Antigravity isn't installed on this Mac\. You can switch now, but it can't reply until it is installed/.test((await missing.textContent()) ?? '')),
    (await missing.textContent().catch(() => '')) ?? '')
  await shot(page, 'missing-cli')
  await review(page).getByRole('button', { name: 'Back' }).click()
  check('D14 Back leaves the conversation on Claude Code', (await page.getByRole('button', { name: 'Agent settings' }).textContent())?.includes('Claude Code') === true)
  await page.keyboard.press('Escape')

  // 3. The conversation changes after the preview: the stale handoff is refused and the new one shown.
  await openReview(page)
  const stale = await shownText(page)
  await apiPost(page, `/api/threads/${threadId}/messages`, { text: 'D13-LATE a message the preview has not shown' })
  await until('late reply', async () => (await replies(page, /^Done\.$/).count()) === 3)
  await review(page).getByRole('button', { name: 'Start handoff', exact: true }).click()
  const alert = review(page).getByRole('alert')
  check('3 a handoff that changed after it was shown is refused', await until('refused', async () => /changed since you reviewed/.test((await alert.textContent()) ?? '')), (await alert.textContent().catch(() => '')) ?? '')
  check('3 and the current handoff is shown in its place', await until('refreshed', async () => (await shownText(page)).includes('D13-LATE')), (await shownText(page)).slice(-160))
  check('3 nothing was sent to Codex', !existsSync(received) && !stale.includes('D13-LATE'))
  await shot(page, 'preview-refreshed')

  // 4. Start handoff: Codex receives exactly the text on screen.
  const shown = await shownText(page)
  await review(page).getByRole('button', { name: 'Start handoff', exact: true }).click()
  await picker(page).waitFor({ state: 'detached' })
  await messageBox(page).fill('What did you get?')
  await messageBox(page).press('Enter')
  check('4 Codex answers after the switch', await until('codex reply', async () => (await replies(page, /^Received \d+ characters of handoff\.$/).count()) === 1))
  const got = existsSync(received) ? readFileSync(received, 'utf8') : ''
  // Cockpit's own guidance goes first when its tools are attached (manager.instructionsFor); nothing else.
  const exact = got === shown || got === `${COCKPIT_GUIDANCE}\n\n${shown}`
  check('4 the receiving agent got exactly the text that was shown', exact && shown.length > 0, `shown ${shown.length}, received ${got.length}, guidance ${got.startsWith(COCKPIT_GUIDANCE) ? 'yes' : 'no'}`)
  check('4 including the late message it was shown', got.includes('USER: D13-LATE a message the preview has not shown'))
  await shot(page, 'switched')

  // 5. Dark and narrow.
  await setTheme(page, 'Dark')
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await picker(page).getByRole('radio', { name: 'Claude Code', exact: true }).click()
  await picker(page).getByRole('button', { name: 'Switch…', exact: true }).click()
  await review(page).getByLabel('Handoff text').waitFor()
  await shot(page, 'preview-dark')
  await page.setViewportSize({ width: 980, height: 640 })
  const fits = await page.evaluate(() => {
    const box = document.querySelector('[role="dialog"][aria-label="Agent settings"]')?.getBoundingClientRect()
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start handoff')?.getBoundingClientRect()
    return { page: document.documentElement.scrollWidth <= innerWidth, panel: box !== undefined && box.left >= 0 && box.right <= innerWidth && box.top >= 0,
      button: start !== undefined && start.bottom <= innerHeight && start.top >= 0 }
  })
  check('5 the review fits a narrow, short window with Start handoff in view', fits.page && fits.panel && fits.button, JSON.stringify(fits))
  await shot(page, 'preview-narrow-dark')
  await page.keyboard.press('Escape')
  await setTheme(page, 'Light')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  if (app) await (await app.firstWindow()).screenshot({ path: join(PROOF_DIR, 'handoff-failure.png') }).catch(() => {})
} finally {
  await app?.close().catch(() => {})
}
finish('PROOF HANDOFF (D13)')
