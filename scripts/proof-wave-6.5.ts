// Packaged gate for wave 6.5, the repair checkpoint (R1–R8). Stand-in agents speak the shapes
// recorded from Claude 2.1.289 and Codex 0.147 (scripts/fixtures/wave65-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-6.5
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { documentsDir } from '../server/files/documents.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave65-proof-'))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\ngamma\n')
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png')).toString('base64')
// R6: a document in Cockpit's own folder, and a folder that will not take a copy.
writeFileSync(join(documentsDir(store.root, project), 'release-plan.md'), '# Release plan\n')
const readOnly = mkdtempSync(join(tmpdir(), 'cockpit-wave65-readonly-'))
chmodSync(readOnly, 0o500)

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
  check('R1 a message with an image waits while the agent works', await until('waiting message', async () =>
    (await waiting.filter({ hasText: 'WITHDRAWN-R1' }).count()) === 1))
  await waiting.filter({ hasText: 'WITHDRAWN-R1' }).getByRole('button', { name: 'Remove' }).click()
  check('R1 Remove takes it back', await until('taken back', async () => (await waiting.count()) === 0))
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

  // R2: one ⌘S in a new workflow's document saves it once, with the text just typed.
  const workflowPosts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/workflows') workflowPosts.push(request.postData() ?? '')
  })
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Workflows/ }).click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByRole('textbox', { name: 'Reference name' }).fill('nightly')
  const body = page.locator('.workflow-doc .ProseMirror')
  await body.click()
  await page.keyboard.type('Watch the nightly build')
  await page.keyboard.press('Meta+s')
  check('R2 the workflow appears in the list', await until('saved', async () => (await page.locator('.workflow-list').getByText('nightly').count()) > 0))
  await page.waitForTimeout(800)
  check('R2 one ⌘S sends one save', workflowPosts.length === 1, `${workflowPosts.length} saves`)
  const saved = await page.evaluate(async (dir) => {
    const list = (await (await fetch(`/api/workflows?projectPath=${encodeURIComponent(dir)}`)).json()) as { data: { name: string; prompt: string }[] }
    return list.data.filter((w) => w.name === 'nightly').map((w) => w.prompt.trim())
  }, project)
  check('R2 it saves the text just typed', JSON.stringify(saved) === JSON.stringify(['Watch the nightly build']), JSON.stringify(saved))
  check('R2 no "already exists" error', (await page.getByText('already exists').count()) === 0)
  await shot(page, 'r2-saved')

  // R3: taking back the only waiting message after the agent's result ends the turn; the
  // conversation is not left "Working" with the switch refused.
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Conversations/ }).click()
  await startConversation(page, 'worklag')
  await until('working', () => working(page))
  await send(page, 'R3 waits in the queue')
  const r3Waiting = page.locator('.message.waiting').filter({ hasText: 'R3 waits in the queue' })
  check('R3 the message waits', await until('r3 waiting', async () => (await r3Waiting.count()) === 1))
  check('R3 the agent finishes its turn while it still waits', await until('result', async () =>
    (await page.locator('.bubble').filter({ hasText: /^Work done\.$/ }).count()) === 1 && (await r3Waiting.count()) === 1, 8_000))
  await r3Waiting.getByRole('button', { name: 'Remove' }).click()
  check('R3 Remove takes it back', await until('r3 taken back', async () => (await r3Waiting.count()) === 0))
  await messageBox(page).fill('')
  check('R3 the conversation stops working at once', await until('not working', async () => !(await working(page)), 2_000),
    (await headStatus(page).textContent()) ?? '')
  await page.waitForTimeout(5_000)
  check('R3 and the message never runs', (await page.locator('.bubble').filter({ hasText: 'Got: R3' }).count()) === 0)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const r3Picker = page.getByRole('dialog', { name: 'Agent settings' })
  await r3Picker.getByRole('radio', { name: 'Codex', exact: true }).click()
  await r3Picker.getByRole('button', { name: 'Switch' }).click()
  check('R3 switching agents is allowed', await until('switched', async () => (await page.getByText('Handed over from Claude Code to Codex').count()) >= 1))
  await shot(page, 'r3-taken-back')

  // R4: while the agent works, Mark as complete is refused in the ⋯ menu and by the server too.
  await startConversation(page, 'worklag again')
  await until('working', () => working(page))
  const r4Thread = await threadIdByTitle(page, 'worklag again')
  await page.locator('.thread-actions').getByRole('button', { name: 'More', exact: true }).click()
  const completeItem = page.getByRole('menuitem', { name: 'Mark as complete' })
  check('R4 the ⋯ menu offers no Mark as complete during a turn', await completeItem.isDisabled())
  check('R4 and it looks unavailable', await completeItem.evaluate((el) => getComputedStyle(el).color !== getComputedStyle(el.nextElementSibling!).color))
  await shot(page, 'r4-menu-working')
  await page.keyboard.press('Escape')
  const refused = await page.evaluate(async (id) => (await fetch(`/api/threads/${id}/completed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: true }) })).status, r4Thread)
  check('R4 the server refuses it while the agent works (409)', refused === 409, `status ${refused}`)
  await until('turn over', async () => !(await working(page)), 15_000)
  await page.locator('.thread-actions').getByRole('button', { name: 'More', exact: true }).click()
  check('R4 after the turn it is offered', await until('enabled', () => completeItem.isEnabled()))
  await completeItem.click()
  check('R4 and completes the conversation', await until('completed', async () => page.evaluate(async (id) => {
    const list = (await (await fetch('/api/threads')).json()) as { data: { meta: { id: string; completed: boolean } }[] }
    return list.data.find((s) => s.meta.id === id)?.meta.completed === true
  }, r4Thread)))

  // R6: moving the documents to a folder that refuses the copies changes nothing, and says which.
  const moved = await page.evaluate(async ([dir, folder]) => {
    const res = await fetch('/api/documents/location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath: dir, folder }) })
    return { status: res.status, body: await res.text() }
  }, [project, readOnly] as const)
  check('R6 a folder that will not take the documents is refused', moved.status === 400, `${moved.status} ${moved.body}`)
  check('R6 and the error names the document', moved.body.includes('release-plan.md'), moved.body)
  const where = await page.evaluate(async (dir) => (await (await fetch(`/api/documents/location?projectPath=${encodeURIComponent(dir)}`)).json()) as { data: { custom: boolean } }, project)
  check('R6 the project keeps its documents folder', where.data.custom === false)
  const listed = await page.evaluate(async (dir) => JSON.stringify(await (await fetch(`/api/documents?projectPath=${encodeURIComponent(dir)}`)).json()), project)
  check('R6 and its documents are all still there', listed.includes('release-plan.md'))

  // R7: Codex offers Ultra only on the models that have it, and a saved Ultra on another model
  // reaches Codex as that model's highest level.
  await page.getByRole('button', { name: 'New conversation' }).click()
  const effortsShown = async (model: string): Promise<string[]> => {
    await chooseAgent(page, { agent: 'codex', model })
    await page.getByRole('button', { name: /^Effort:/ }).click()
    const shown = await page.getByRole('menu', { name: 'Effort' }).getByRole('menuitemradio').allTextContents()
    await page.keyboard.press('Escape')
    return shown
  }
  check('R7 gpt-5.6-sol offers Ultra', (await effortsShown('gpt-5.6-sol')).at(-1) === 'Ultra')
  check('R7 gpt-5.6-luna stops at Max', (await effortsShown('gpt-5.6-luna')).at(-1) === 'Max')
  check('R7 gpt-5.5 stops at Xhigh', (await effortsShown('gpt-5.5')).at(-1) === 'Xhigh')
  await shot(page, 'r7-luna-efforts')
  await chooseAgent(page, { agent: 'claude', model: '' })
  const ultraOnLuna = await apiPost(page, '/api/threads', { projectPath: project, text: 'R7 ultra on luna', settings: { agent: 'codex', model: 'gpt-5.6-luna', effort: 'ultra' } }) as { data: { id: string } }
  await page.evaluate((id) => { location.search = `?thread=${id}` }, ultraOnLuna.data.id)
  const r7Reply = page.locator('.bubble').filter({ hasText: /Effort \w+\.$/ })
  check('R7 a saved Ultra on gpt-5.6-luna reaches Codex as Max', await until('r7 reply', async () => /Effort max\.$/.test((await r7Reply.textContent().catch(() => '')) ?? '')),
    (await r7Reply.textContent().catch(() => '')) ?? '')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => {})
  chmodSync(readOnly, 0o700)
}
finish('PROOF WAVE 6.5')
