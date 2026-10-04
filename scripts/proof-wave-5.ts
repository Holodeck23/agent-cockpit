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

  // J6: the agent's questions arrive as one card with choices; the answers go back and stay shown.
  await send(page, 'ask')
  const card = page.locator('.question-card').last()
  check('J6 the questions arrive as one card and the conversation needs you', await until('card', async () =>
    (await card.locator('.question').count()) === 2 && (await headStatus(page).textContent())?.includes('Needs you') === true))
  check('J6 each choice shows its description', (await card.getByText('Cool and calm').count()) === 1)
  await card.getByRole('radio', { name: /^Blue/ }).check()
  await card.getByRole('checkbox', { name: /^Small/ }).check()
  await card.getByRole('checkbox', { name: /^Large/ }).check()
  await shot(page, 'j6-question')
  await card.getByRole('button', { name: 'Send answers' }).click()
  check('J6 the agent gets the answers', await until('answers', async () =>
    (await page.locator('.bubble').filter({ hasText: 'Noted: "Which colour?":"Blue","Which sizes?":"Small, Large"' }).count()) === 1))
  check('J6 the card keeps the answers', (await card.locator('.question-answer').allTextContents()).join('|') === 'Blue|Small, Large')
  await send(page, 'ask')
  const second = page.locator('.question-card').last()
  await until('second card', async () => (await page.locator('.question-card').count()) === 2)
  await second.getByRole('button', { name: 'Dismiss' }).click()
  check('J6 Dismiss closes the questions and the agent carries on', await until('dismissed', async () =>
    (await page.getByText('You closed the questions; carrying on without them.').count()) === 1
    && (await second.textContent())?.includes('Closed without answers') === true
    && (await second.locator('.question-answer').count()) === 0))
  await shot(page, 'j6-answered')

  // J1: a message sent mid-turn waits visibly; Remove puts it back in the draft; the rest run after the turn.
  await send(page, 'work')
  await until('working', async () => (await headStatus(page).textContent())?.includes('Working') === true)
  await send(page, 'keep me')
  await send(page, 'take me back')
  const waiting = page.locator('.message.waiting')
  check('J1 messages sent mid-turn show as waiting', await until('waiting', async () => (await waiting.count()) === 2))
  await shot(page, 'j1-waiting')
  await waiting.filter({ hasText: 'take me back' }).getByRole('button', { name: 'Remove' }).click()
  check('J1 Remove takes the message back into the draft', await until('draft', async () =>
    (await messageBox(page).inputValue()) === 'take me back' && (await waiting.count()) === 1))
  await messageBox(page).fill('')
  check('J1 the waiting message runs after the turn, and the removed one never does', await until('drained', async () =>
    (await page.locator('.bubble').filter({ hasText: /^Got: keep me$/ }).count()) === 1 && (await waiting.count()) === 0, 15_000)
    && (await page.locator('.bubble').filter({ hasText: 'Got: take me back' }).count()) === 0)
  check('J1 the conversation is done once the queue is empty', await until('done', async () => (await headStatus(page).textContent())?.includes('Working') === false))

  // J1: Stop and send now stops the turn and runs the waiting message straight away.
  await send(page, 'work')
  await until('working', async () => (await headStatus(page).textContent())?.includes('Working') === true)
  await send(page, 'now please')
  await waiting.filter({ hasText: 'now please' }).getByRole('button', { name: 'Stop and send now' }).click()
  check('J1 Stop and send now runs the waiting message at once', await until('now', async () =>
    (await page.locator('.bubble').filter({ hasText: /^Got: now please$/ }).count()) === 1, 3_000)
    && (await page.getByText('Work done.').count()) === 1)

  // J3: compaction shows in the header while it runs, then as a line with the sizes.
  await send(page, 'compact')
  const compaction = page.locator('.step.compaction')
  check('J3 the header says Compacting while it runs', await until('compacting', async () => (await headStatus(page).textContent())?.includes('Compacting') === true))
  check('J3 a live line says the agent is making room', (await compaction.last().textContent())?.includes('Making room') === true)
  await shot(page, 'j3-compacting')
  check('J3 it ends as a line with the sizes', await until('compacted', async () =>
    (await compaction.last().textContent())?.includes('Summarised the conversation to make room · 34k → 2.8k tokens') === true))
  check('J3 and the header goes back to the turn state', await until('done', async () => (await headStatus(page).textContent())?.includes('Compacting') === false))

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
