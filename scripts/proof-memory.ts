// U13 cross-conversation memory gate, run against the PACKAGED app (npm run package first): `npm run proof:memory`.
// No agent usage: the stand-in (scripts/fixtures/memory-agent) calls the cockpit MCP memory API with
// its session token, asking first for `remember` the way Claude Code does. A fact remembered in one
// conversation (after you allow it) is recalled in the next with its date and an out-of-date note; a
// denied one is not stored; the Memory view adds, edits, deletes and clears; nothing lands in the project.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject } from './lib/ui.ts'

interface Entry { id: string; scope: string; text: string; source: { kind: string; threadId?: string } }
const FACT = 'Deploys go to staging first; production needs a tagged release.'
const home = mkdtempSync(join(tmpdir(), 'cockpit-memory-proof-'))
const project = join(home, 'shop-site')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# shop\n')
const memory = (page: Page): Promise<Entry[]> => page.evaluate(async (p) =>
  ((await (await fetch(`/api/memory?projectPath=${encodeURIComponent(p)}`)).json()) as { data: Entry[] }).data, project)
const threadId = (page: Page, title: string): Promise<string | undefined> => page.evaluate(async (t) =>
  ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { id: string; title: string } }> }).data.find((r) => r.meta.title.startsWith(t))?.meta.id, title)
async function start(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: text.slice(0, 20) }).waitFor()
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/memory-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  await openProject(page, project, 'Shop site')

  // Conversation A: remember, after you allow it.
  await start(page, 'Please remember how we deploy')
  const card = page.locator('.approval.open')
  await card.waitFor()
  check('remember asks first, showing what it will keep', (await card.innerText()).includes('Remember') && (await card.innerText()).includes(FACT))
  check('nothing is stored before you answer', (await memory(page)).length === 0)
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  const stored = await memory(page)
  check('allowed, the fact is kept for this project and names its conversation', stored.length === 1 && stored[0]!.text === FACT && stored[0]!.scope === 'project'
    && stored[0]!.source.kind === 'conversation' && stored[0]!.source.threadId === await threadId(page, 'Please remember'))

  // Conversation B: recall, with no prompt.
  await start(page, 'What do you recall about deploys?')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('recall needs no approval', await page.locator('.approval').count() === 0)
  const answer = await page.locator('.bubble.agent').last().innerText()
  check('the next conversation recalls it, dated, with a reminder that memory ages',
    answer.includes(FACT) && /may be out of date/.test(answer) && /\[\d{4}-\d{2}-\d{2}, this project, from a conversation\]/.test(answer), answer.slice(0, 160))
  const labels = await page.locator('.step-label').allInnerTexts()
  check('the step reads as a memory search', labels.includes('Searching memory for “staging deploy”'), labels.join(' | '))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-memory-recall.png') })

  // Conversation C: a denied remember stores nothing.
  await start(page, 'Please remember this too')
  await page.locator('.approval.open').getByRole('button', { name: 'Deny', exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('a denied remember stores nothing', (await memory(page)).length === 1)

  // The Memory view.
  await page.getByRole('tab', { name: 'Memory', exact: true }).click()
  const view = page.locator('main.memory')
  const projectSection = view.getByRole('region', { name: 'This project' })
  await projectSection.locator('.memory-entry').first().waitFor()
  check('the Memory view lists it with its conversation', (await projectSection.innerText()).includes(FACT)
    && await projectSection.getByRole('button', { name: '“Please remember how we deploy”', exact: false }).count() === 1)
  await view.getByRole('textbox', { name: 'New memory' }).fill('Prefers short commit messages.')
  await view.getByRole('radiogroup', { name: 'Keep it for' }).getByRole('radio', { name: 'Everywhere' }).click()
  await view.getByRole('button', { name: 'Remember', exact: true }).click()
  const everywhere = view.getByRole('region', { name: 'Everywhere' })
  await everywhere.getByText('Prefers short commit messages.').waitFor()
  check('you can add a preference kept everywhere, marked as from you', (await everywhere.innerText()).includes('from you')
    && (await memory(page)).some((e) => e.scope === 'everywhere' && e.source.kind === 'you'))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-memory.png') })

  await projectSection.getByRole('button', { name: /^Edit/ }).click()
  await projectSection.getByRole('textbox', { name: 'Edit memory' }).fill('Deploys go to staging first.')
  await projectSection.getByRole('button', { name: 'Save', exact: true }).click()
  await projectSection.getByText('Deploys go to staging first.', { exact: true }).waitFor()
  check('editing changes the note', (await memory(page)).some((e) => e.text === 'Deploys go to staging first.'))
  await everywhere.getByRole('button', { name: /^Delete/ }).click()
  await everywhere.getByText('No preferences yet.', { exact: false }).waitFor()
  check('deleting removes it', !(await memory(page)).some((e) => e.scope === 'everywhere'))
  await view.getByRole('button', { name: /Clear this project/ }).click()
  await view.getByRole('alertdialog').getByRole('button', { name: 'Clear', exact: true }).click()
  await projectSection.getByText('Nothing remembered for this project yet.').waitFor()
  check('clearing forgets the project\'s notes', (await memory(page)).length === 0)
  check('nothing was written into the project folder', JSON.stringify(readdirSync(project)) === JSON.stringify(['README.md']))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-memory-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF MEMORY')
