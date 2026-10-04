// Packaged gate for wave 6.5, the repair checkpoint (R1–R8). Stand-in agents speak the shapes
// recorded from Claude 2.1.289 and Codex 0.147 (scripts/fixtures/wave65-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-6.5
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave65-proof-'))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\ngamma\n')
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png')).toString('base64')

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave65-${name}.png`) })
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
const working = async (page: Page): Promise<boolean> => (await headStatus(page).textContent())?.includes('Working') === true
/** The open conversation's id, from the list (the URL is not always updated yet). */
const threadIdByTitle = (page: Page, title: string): Promise<string> => page.evaluate(async (t) => {
  const list = (await (await fetch('/api/threads')).json()) as { data: { meta: { id: string; title: string } }[] }
  return list.data.find((s) => s.meta.title.startsWith(t))?.meta.id ?? ''
}, title)

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'App')

  // R1: switching agents hands over the conversation as it stands: your answers to question
  // cards and the questions you dismissed, never a message (or its image) you took back.
  await startConversation(page, 'ask')
  const card = page.locator('.question-card').last()
  await until('question card', async () => (await card.locator('.question').count()) === 2)
  await card.getByRole('radio', { name: /^Blue/ }).check()
  await card.getByRole('checkbox', { name: /^Small/ }).check()
  await card.getByRole('button', { name: 'Send answers' }).click()
  await until('answers sent', async () => (await page.locator('.bubble').filter({ hasText: /^Noted:/ }).count()) === 1)
  await send(page, 'ask')
  await until('second card', async () => (await page.locator('.question-card').count()) === 2)
  await page.locator('.question-card').last().getByRole('button', { name: 'Dismiss' }).click()
  await until('dismissed', async () => (await page.getByText('You closed the questions; carrying on without them.').count()) === 1)
  await send(page, 'work')
  await until('working', () => working(page))
  const r1Thread = await threadIdByTitle(page, 'ask')
  await apiPost(page, `/api/threads/${r1Thread}/messages`, { text: 'WITHDRAWN-R1 use Mongo instead', images: [{ data: ICON, name: 'mongo.png' }] })
  const waiting = page.locator('.message.waiting')
  await until('waiting message', async () => (await waiting.filter({ hasText: 'WITHDRAWN-R1' }).count()) === 1)
  await waiting.filter({ hasText: 'WITHDRAWN-R1' }).getByRole('button', { name: 'Remove' }).click()
  await until('taken back', async () => (await waiting.count()) === 0)
  await messageBox(page).fill('')
  await until('turn over', async () => !(await working(page)), 20_000)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const picker = page.getByRole('dialog', { name: 'Agent settings' })
  await picker.getByRole('radio', { name: 'Codex', exact: true }).click()
  await picker.getByRole('button', { name: 'Switch' }).click()
  await send(page, 'What was chosen?')
  const handoff = page.locator('.bubble').filter({ hasText: /^Handoff: / })
  check('R1 the switched-in agent answers', await until('codex reply', async () => (await handoff.count()) === 1))
  const carried = (await handoff.textContent().catch(() => '')) ?? ''
  check('R1 the handoff carries your answer to the question card', carried.includes('answered Blue yes'), carried)
  check('R1 the handoff says you dismissed the other questions', carried.includes('dismissed yes'), carried)
  check('R1 the handoff leaves out the message you took back', carried.includes('withdrawn no'), carried)
  check('R1 and the image you sent with it', carried.includes('attached images 0'), carried)
  await shot(page, 'r1-switched')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => {})
}
finish('PROOF WAVE 6.5')
