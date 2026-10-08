// Antigravity U10 gate, PACKAGED app. The stand-in speaks recorded `agy` stream-json shapes,
// while `npm run smoke:antigravity` separately proves the user's real subscription and resume.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject } from './lib/ui.ts'

const MODEL = 'gemini-3.8-flash-low'
const SESSION = '055a398f-db14-4c5f-abbb-1bf03f8120a7'
const home = mkdtempSync(join(tmpdir(), 'cockpit-antigravity-proof-'))
const project = join(home, 'subscription-agent')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# subscription agent\n')
const state = join(home, 'state')
const env = { COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/antigravity-agent') }

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  return { app, page }
}

const meta = (page: Page): Promise<{ sessionId: string; settings: { agent: string; model?: string } }> =>
  page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { sessionId: string; settings: { agent: string; model?: string } } }> }).data[0]!.meta)

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
let { app, page } = await launch()
try {
  await openProject(page, project, 'Subscription agent')
  // Without these (and without Cockpit's tools, P3) agy gets no instructions block at all.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Subscription agent settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'Subscription agent' })
  await settings.getByLabel('Project instructions').fill('Keep replies short.')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await settings.getByText('saved').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByRole('radio', { name: 'Antigravity', exact: true }).click()
  // Since W10-01 agy is not run just to show the picker: Refresh checks it.
  await panel.getByRole('button', { name: 'Refresh' }).click()
  await panel.getByText('1.2.14 (Cockpit Antigravity fixture)').waitFor()
  check('the picker offers Antigravity and detects agy', true)
  const menu = await panel.getByLabel('Model').locator('option').evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).value}=${o.textContent}`))
  check('the Model menu lists agy\'s models once each, by name', menu.join('|') === '=Default model|gemini-3.8-flash=Gemini 3.8 Flash|gemini-3.1-pro=Gemini 3.1 Pro', menu.join(' | '))
  check('the picker explains the headless approval limitation', (await panel.innerText()).includes('cannot pause for approval'))
  await page.keyboard.press('Escape')
  // By name; its one listed effort (Low) makes the id agy gets: gemini-3.8-flash-low.
  await chooseAgent(page, { agent: 'antigravity', model: 'gemini-3.8-flash', permissions: 'manual' })

  await page.getByRole('button', { name: 'New conversation' }).click()
  const chip = (await page.getByRole('button', { name: 'Agent settings' }).locator('.picker-sub').innerText()).trim()
  check('the composer chip names the model and its effort, not agy\'s id', chip === 'Gemini 3.8 Flash · Low', chip)
  await messageBox(page).fill('Read the project and report')
  await messageBox(page).press('Enter')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  const first = await page.locator('.transcript').innerText()
  check('the selected model and Cockpit instructions reach agy', first.includes(`Using ${MODEL}`) && first.includes('instructions received'), first)
  check('Antigravity tool events become plain activity', first.includes('Reading README.md'))
  const saved = await meta(page)
  check('Cockpit stores Antigravity\'s conversation id', saved.sessionId === SESSION && saved.settings.agent === 'antigravity')
  await page.screenshot({ path: join(PROOF_DIR, 'proof-antigravity.png') })

  await app.close()
  ;({ app, page } = await launch())
  await page.locator('.card').first().click()
  // Count the restored transcript only after its detail has loaded.
  await messageBox(page).waitFor()
  const userMessages = page.locator('.bubble.user')
  const agentMessages = page.locator('.bubble.agent')
  const before = await userMessages.count()
  const agentBefore = await agentMessages.count()
  await messageBox(page).fill('Continue after restart')
  await messageBox(page).press('Enter')
  await userMessages.nth(before).waitFor()
  await agentMessages.nth(agentBefore).waitFor()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await page.locator('.bubble.agent').filter({ hasText: `Resumed ${SESSION}.` }).waitFor()
  check('a packaged restart resumes the same agy conversation', (await page.locator('.transcript').innerText()).includes(`Resumed ${SESSION}.`))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-antigravity-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF ANTIGRAVITY')
