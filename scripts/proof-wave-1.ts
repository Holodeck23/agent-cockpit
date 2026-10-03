// Packaged gate for parity wave 1 (reading + attention). Stand-in agent, no provider usage.
// Usage: npm run package (or COCKPIT_APP=<path>/Cockpit.app), then npm run proof:wave-1
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT, setLooking } from './lib/launch-app.ts'
import { apiPost, headStatus, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave1-proof-'))
const project = join(root, 'project')
mkdirSync(project)
writeFileSync(join(project, 'notes.md'), '# Notes\n')
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })

let clock = Date.parse('2026-10-03T09:00:00Z')
const seed = (title: string, events: NormalizedEvent[], completed = false): string => {
  const ts = new Date(clock).toISOString()
  const meta = store.create({ id: randomUUID(), title, projectPath: project, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed, createdAt: ts, updatedAt: ts })
  for (const event of events) store.append(meta.id, event, new Date((clock += 1000)).toISOString())
  return meta.id
}
const says = (text: string, id = randomUUID()): NormalizedEvent => ({ kind: 'assistant_text', messageId: id, text })
const done: NormalizedEvent = { kind: 'result', ok: true }

const history: NormalizedEvent[] = [{ kind: 'user_text', text: 'Walk me through the release.' }]
for (let i = 1; i <= 40; i += 1) history.push(says(`Step ${i}: a paragraph long enough to take some room in the conversation, so it scrolls.`))
history.push(done)
const longId = seed('Long history', history)
seed('Clips', [
  { kind: 'user_text', text: '@file:notes.md @workflow:review Check this', workflows: [{ name: 'review', prompt: 'Review the diff for risky changes.' }] },
  says('Checked.'), done,
])
seed('Deploy question', [{ kind: 'user_text', text: 'Deploy?' }, says('Question: Staging or production?'), done])

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave1-${name}.png`) })
const scroller = (page: Page) => page.locator('.thread .events')
const scrollState = (page: Page) => scroller(page).evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }))
const badge = () => app.evaluate(({ app }) => app.dock?.getBadge() ?? '')
/** Polls from Node (an async waitForFunction predicate is always truthy). */
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test()) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Wave one')
  const open = async (title: string) => {
    await page.locator('.card').filter({ hasText: title }).click()
    await page.getByRole('heading', { level: 1, name: title }).waitFor()
  }

  // A1: opens at the end; a reader who scrolled up stays put and is offered Jump to latest.
  await open('Long history')
  check('A1 a conversation opens at its latest message', (await scrollState(page)).gap <= 40)
  await page.getByRole('textbox', { name: 'Message' }).fill('slow')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.locator('.bubble.user').filter({ hasText: /^slow$/ }).waitFor()
  await headStatus(page).filter({ hasText: 'Working' }).waitFor()
  check('A1 sending jumps to the bottom', await until('the bottom after sending', async () => (await scrollState(page)).gap <= 40))
  await scroller(page).evaluate((el) => { el.scrollTop = 0 })
  await page.getByText('Late reply.').waitFor()
  check('A1 a late reply does not pull a reader who scrolled up', (await scrollState(page)).top < 50, `top ${(await scrollState(page)).top}`)
  const jump = page.getByRole('button', { name: 'Jump to latest' })
  check('A1 Jump to latest appears when something new arrives', await jump.isVisible())
  await shot(page, 'a1-jump-to-latest')
  await jump.click()
  check('A1 Jump to latest goes to the end and hides', await until('the end after jumping', async () => (await scrollState(page)).gap <= 40 && !(await jump.isVisible())))

  // A2: copy a message.
  const message = page.locator('.message').filter({ hasText: 'Late reply.' }).last()
  await message.hover()
  await message.getByRole('button', { name: 'Copy message' }).click()
  check('A2 Copy message puts the text on the clipboard', await until('the clipboard', async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === 'Late reply.'))
  check('A2 the button confirms Copied', await message.getByRole('button', { name: 'Copied' }).isVisible())

  // A3: ⌘F finds, steps and clears.
  await page.getByRole('textbox', { name: 'Message' }).fill('show me')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.getByText('Third paragraph: needle again').waitFor()
  await page.locator('.thread-head h1').click()
  await page.keyboard.press('Meta+f')
  const find = page.getByRole('searchbox', { name: 'Find in conversation' })
  check('A3 ⌘F opens the find bar with focus', await find.evaluate((el) => el === document.activeElement))
  await find.fill('needle')
  const count = page.locator('.find-count')
  check('A3 counts every match, ignoring case', await until('3 matches', async () => (await count.innerText()) === '1 of 3'), await count.innerText())
  check('A3 matches are highlighted', await page.evaluate(() => CSS.highlights.get('cockpit-find')?.size === 3 && CSS.highlights.get('cockpit-find-current')?.size === 1))
  await find.press('Enter')
  check('A3 Enter steps to the next match', (await count.innerText()) === '2 of 3')
  await find.press('Shift+Enter')
  await find.press('Shift+Enter')
  check('A3 Shift+Enter steps back and wraps', (await count.innerText()) === '3 of 3')
  await find.fill('zebra')
  check('A3 no matches says so', (await count.innerText()) === 'No matches')
  await find.fill('needle')
  await shot(page, 'a3-find')
  await find.press('Escape')
  check('A3 Esc closes the bar and clears highlights', !(await find.isVisible()) && await page.evaluate(() => !CSS.highlights.has('cockpit-find')))

  // A6: a calmer bar. Stop/Complete under the title, Find and the transcript in the menu.
  const status = page.locator('.thread-status')
  check('A6 Complete sits under the title', await status.getByRole('button', { name: 'Mark complete' }).isVisible())
  check('A6 Stop shows under the title only while a turn runs', (await status.getByRole('button', { name: 'Stop' }).count()) === 0)
  check('A6 the transcript path left the header', (await status.innerText()).includes('messages.md') === false)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: /Find in conversation/ }).click()
  check('A6 Find in conversation is in the menu and opens the bar', await find.isVisible())
  await find.press('Escape')

  // A7: a sent message shows its file and workflow as clips.
  await open('Clips')
  const clips = page.getByRole('list', { name: 'Sent with this message' })
  check('A7 the file shows as a clip with its path', await clips.locator('[title="notes.md"]').isVisible())
  check('A7 the workflow token is replaced by a clip', (await page.locator('.bubble.user').first().innerText()).startsWith('Check this') && await clips.locator('.workflow-clip').isVisible())
  await clips.locator('.workflow-clip summary').click()
  check('A7 the workflow clip opens to the instructions it sent', await clips.getByText('Review the diff for risky changes.').isVisible())
  await shot(page, 'a7-clips')

  // B3 + B4: a question needs you until dismissed; a completed conversation never does.
  check('B3 a question counts in the Dock badge', await until('badge 1', async () => (await badge()) === '1'), `badge "${await badge()}"`)
  await open('Deploy question')
  await page.getByRole('button', { name: 'Dismiss' }).click()
  check('B4 Dismiss clears the question and the badge', await until('badge cleared', async () => (await badge()) === ''))
  check('B4 the Dismiss button goes away', await until('no Dismiss', async () => (await page.getByRole('button', { name: 'Dismiss' }).count()) === 0))
  await page.getByRole('textbox', { name: 'Message' }).fill('ask')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await headStatus(page).filter({ hasText: 'Needs you' }).waitFor()
  check('B3 a new question needs you again', await until('badge 1 again', async () => (await badge()) === '1'))
  await page.getByRole('button', { name: 'Mark complete' }).first().click()
  check('B3 Mark complete takes it out of the badge', await until('badge cleared by complete', async () => (await badge()) === ''))
  await page.getByRole('button', { name: 'Reopen' }).first().click()
  check('B4 reopening does not bring the question back', await until('still no badge', async () => (await badge()) === '', 1500) || (await badge()) === '')

  // B1 + B2: other conversations notify (and chime); the one you are looking at stays quiet.
  await page.evaluate(() => localStorage.setItem('cockpit:sounds', JSON.stringify({ reply: true, decision: true })))
  await page.reload()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  await setLooking(app, page, true)
  // Record instead of showing, so a proof run never puts banners on the Mac's screen.
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { proofNotes: Electron.Notification[] }
    g.proofNotes = []
    Notification.prototype.show = function (this: Electron.Notification) { g.proofNotes.push(this) }
  })
  const notes = () => app.evaluate(() => (globalThis as unknown as { proofNotes: Electron.Notification[] }).proofNotes.map((n) => `${n.title} | ${n.body}`))
  await page.evaluate(() => {
    const w = window as unknown as { heard: string[] }
    w.heard = []
    window.addEventListener('cockpit:sound', (e) => w.heard.push((e as CustomEvent<string>).detail))
  })
  const heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard.join(','))
  await open('Clips')
  await apiPost(page, `/api/threads/${longId}/messages`, { text: 'show me again' })
  check('B1 a turn finishing elsewhere notifies with the conversation and its reply', await until('a notification', async () => (await notes()).some((n) => n.startsWith('Long history | Finished: First paragraph'))), (await notes()).join(' / '))
  check('B2 and chimes, because you are not looking at that conversation', await until('the reply sound', async () => (await heard()) === 'reply'), await heard())
  await page.getByRole('textbox', { name: 'Message' }).fill('hello')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.locator('.message').filter({ hasText: 'First paragraph' }).last().waitFor()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await new Promise((r) => setTimeout(r, 800))
  check('B1 the conversation you are looking at does not notify', (await notes()).length === 1, (await notes()).join(' / '))
  check('B2 and does not chime', (await heard()) === 'reply', await heard())
  await app.evaluate(() => { (globalThis as unknown as { proofNotes: Electron.Notification[] }).proofNotes[0]!.emit('click') })
  check('B1 clicking the notification opens its conversation', await until('Long history opened', async () => (await page.getByRole('heading', { level: 1, name: 'Long history' }).count()) === 1))
  await setLooking(app, page, false)
  await page.getByRole('textbox', { name: 'Message' }).fill('ask')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  check('B1 away from the window, even the open conversation notifies, with its question', await until('the question notification', async () => (await notes()).some((n) => n === 'Long history | Question: Staging or production?')), (await notes()).join(' / '))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('checkbox', { name: /^When an agent finishes a turn/ }).uncheck()
  await shot(page, 'b1-settings')
  await page.keyboard.press('Escape')
  const before1 = (await notes()).length
  await apiPost(page, `/api/threads/${longId}/messages`, { text: 'once more' })
  await page.locator('.message').filter({ hasText: 'First paragraph' }).nth(2).waitFor()
  await new Promise((r) => setTimeout(r, 800))
  check('B1 turning finished-turn notifications off stops them', (await notes()).length === before1, (await notes()).join(' / '))

  // A5: the conversation list resizes by dragging its edge, within bounds, and remembers it.
  const listWidth = () => page.locator('.list').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const handle = page.getByRole('separator', { name: 'Resize conversation list' })
  const before = await listWidth()
  const drag = async (dx: number) => {
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + 200, { steps: 8 })
    await page.mouse.up()
  }
  await drag(100)
  check('A5 dragging the edge widens the list', Math.abs((await listWidth()) - (before + 100)) <= 2, `${before} → ${await listWidth()}`)
  await drag(-600)
  check('A5 the list stops at its minimum width', (await listWidth()) === 260, String(await listWidth()))
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  check('A5 arrow keys resize the focused handle', (await listWidth()) === 276)
  await page.reload()
  await page.locator('.list').waitFor()
  check('A5 the width is remembered', (await listWidth()) === 276)

  // Themes and a narrow window for the screenshots.
  await open('Clips')
  await setTheme(page, 'Dark')
  await shot(page, 'dark')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await shot(page, 'narrow')
} finally {
  await app.close()
}
finish('PROOF WAVE 1')
