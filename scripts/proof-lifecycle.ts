// U12 turn-lifecycle gate, run against the PACKAGED app (npm run package first): `npm run proof:lifecycle`.
// No agent usage: the stand-in (scripts/fixtures/lifecycle-agent) answers every turn with an
// acknowledgement, a tool step, updates and a conclusion; "question" and "blocker" in the message
// pick the kind of conclusion. Checks how each part is drawn, the list preview, Needs you, the
// decision sound and the Dock badge, and that replying to a question clears it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, setLooking, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject } from './lib/ui.ts'

interface Summary { meta: { title: string }; status: string; preview: string; awaiting?: string }
const home = mkdtempSync(join(tmpdir(), 'cockpit-lifecycle-proof-'))
const project = join(home, 'landing-page')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# demo\n')
const summary = async (page: Page, title: string): Promise<Summary | undefined> =>
  (await page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Summary[] }).data)).find((t) => t.meta.title.startsWith(title))
const heard = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { heard: string[] }).heard)
async function start(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: text.slice(0, 20) }).waitFor()
}
const transcript = (page: Page) => page.locator('.transcript')

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/lifecycle-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  await openProject(page, project, 'Landing page')
  // The user is in another app, so the open conversation chimes too (B2 silences it only while you look).
  await setLooking(app, page, false)
  // Set once the app has mounted (it saves its own defaults on first render), then reload to read them.
  await page.evaluate(() => localStorage.setItem('cockpit:sounds', JSON.stringify({ reply: true, decision: true })))
  await page.reload()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  await page.evaluate(() => {
    const w = window as unknown as { heard: string[] }
    w.heard = []
    window.addEventListener('cockpit:sound', (e) => w.heard.push((e as CustomEvent<string>).detail))
  })

  // An answer: acknowledgement, updates, conclusion.
  await start(page, 'Speed up the landing page')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('the acknowledgement shows first, quietly', (await transcript(page).locator('.bubble.ack').innerText()).includes('On it: checking the project first.'))
  const updates = await transcript(page).locator('.update-line').allInnerTexts()
  check('interim messages read as compact updates', updates.length === 2 && updates[0]!.includes('Tests pass.') && updates[1]!.includes('Build is clean.'), updates.join(' | '))
  check('a long update keeps its detail folded', await transcript(page).locator('details.update-line').count() === 1)
  const bubbles = await transcript(page).locator('.bubble.agent:not(.ack)').allInnerTexts()
  check('the conclusion is the last full message, untagged when it is an answer',
    bubbles.at(-1)?.startsWith('Done. The page now loads') === true && await transcript(page).locator('.conclusion-tag').count() === 0)
  const answered = await summary(page, 'Speed up')
  check('the list preview is the conclusion, not an update', answered?.preview === 'Done. The page now loads in under a second.' && !answered.awaiting, answered?.preview)
  check('a finished answer plays the reply sound', JSON.stringify(await heard(page)) === '["reply"]', `${(await heard(page)).join(', ')} | stored ${await page.evaluate(() => localStorage.getItem('cockpit:sounds'))} | listening ${await page.evaluate(() => Array.isArray((window as unknown as { heard?: unknown }).heard))}`)

  // A question: it ends the turn and waits on you.
  await start(page, 'Deploy it, ask me a question if unsure')
  await transcript(page).locator('.conclusion-tag.question').waitFor()
  check('a question is labelled and shown without its marker', (await transcript(page).locator('.conclusion-question .bubble').innerText()).trim() === 'Should this go to staging or production?')
  await headStatus(page).filter({ hasText: 'Needs you' }).waitFor()
  check('the conversation reads Needs you, in the header and the list', await page.locator('.card').filter({ hasText: 'Deploy it' }).locator('.pill-needs_input').count() === 1)
  check('it counts under the Needs you filter', /Needs you\s*1/.test(await page.getByRole('tablist', { name: 'Filter conversations' }).innerText()))
  check('the summary says it is waiting on a question', (await summary(page, 'Deploy it'))?.awaiting === 'question')
  check('a question plays the decision sound', (await heard(page)).at(-1) === 'decision', (await heard(page)).join(', '))
  check('the Dock badge counts it', await app.evaluate(({ app: a }) => a.dock!.getBadge()) === '1')
  await page.screenshot({ path: join(PROOF_DIR, 'proof-lifecycle.png') })

  await messageBox(page).fill('Staging, please.')
  await messageBox(page).press('Enter')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('replying answers it: no longer waiting, badge cleared', !(await summary(page, 'Deploy it'))?.awaiting
    && await app.evaluate(({ app: a }) => a.dock!.getBadge()) === '')

  // A blocker.
  await start(page, 'Ship it even with a blocker')
  await transcript(page).locator('.conclusion-tag.blocker').waitFor()
  check('a blocker is labelled and waits on you', (await transcript(page).locator('.conclusion-blocker .bubble').innerText()).trim() === 'The deploy key is missing from this machine.'
    && (await summary(page, 'Ship it'))?.awaiting === 'blocker')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-lifecycle-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF LIFECYCLE')
