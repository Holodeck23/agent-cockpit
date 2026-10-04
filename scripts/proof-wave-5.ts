// Packaged gate for parity wave 5 (turn flow + structured events). Stand-in agent speaking the
// shapes recorded from Claude 2.1.289 (scripts/fixtures/wave5-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-5
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject, setTheme, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave5-proof-'))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\ngamma\n')
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave5-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave5-${name}.png`) })
/** Polls from Node (an async waitForFunction predicate is always truthy). */
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const send = async (page: Page, text: string): Promise<void> => {
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
}

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'App')

  // J7: a helper shows as one line with its steps and report; the conversation stays working
  // while it runs, then the agent reports back on its own.
  await startConversation(page, 'delegate')
  const helper = page.locator('.helper').filter({ hasText: 'Count lines in notes.txt' })
  check('J7 the delegating step becomes a helper line', await until('helper', async () => (await helper.count()) === 1))
  check('J7 the conversation keeps working while the helper runs', await until('working', async () =>
    (await page.locator('.helper-count').textContent()) === '1 helper working' && (await headStatus(page).textContent())?.includes('Working') === true))
  await shot(page, 'j7-helper-running')
  check('J7 the helper finishes and the agent reports back', await until('report', async () =>
    (await helper.locator('.helper-meta').textContent())?.includes('Helper finished') === true
    && (await page.getByText('The helper says notes.txt has 4 lines.').count()) === 1, 12_000))
  check('J7 no helper count once it is done', (await page.locator('.helper-count').count()) === 0)
  check("J7 the helper's own answer is not shown as the agent's reply", (await page.locator('.bubble').filter({ hasText: /^notes\.txt has 4 lines\.$/ }).count()) === 0)
  await helper.locator('summary').click()
  check('J7 opening the helper shows its step and its report', (await helper.locator('.helper-steps li').allTextContents()).join('|') === 'Reading notes.txt'
    && (await helper.locator('.helper-answer').textContent())?.trim() === 'notes.txt has 4 lines.')
  await shot(page, 'j7-helper-open')

  // J7: Stop stops a helper that outlives the turn.
  await send(page, 'long')
  const watcher = page.locator('.helper').filter({ hasText: 'Watch the build' })
  check('J7 a long helper keeps the conversation working after the turn', await until('long', async () => (await page.locator('.helper-count').count()) === 1))
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  check('J7 Stop stops the helper', await until('stopped', async () => (await watcher.locator('.helper-meta').textContent())?.includes('Helper stopped') === true))
  check('J7 and the conversation is no longer working', await until('idle', async () => (await page.locator('.helper-count').count()) === 0
    && (await headStatus(page).textContent())?.includes('Working') === false))

  await setTheme(page, 'Dark')
  await shot(page, 'thread-dark')
  await setTheme(page, 'Light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  await shot(page, 'thread-narrow')
} finally {
  await app.close()
}
finish('PROOF WAVE 5')
