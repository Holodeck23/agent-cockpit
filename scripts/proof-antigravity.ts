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
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByRole('radio', { name: 'Antigravity', exact: true }).click()
  await panel.getByText('1.2.14 (Cockpit Antigravity fixture)').waitFor()
  check('the picker offers Antigravity and detects agy', true)
  check('the picker explains the headless approval limitation', (await panel.innerText()).includes('cannot pause for approval'))
  await page.keyboard.press('Escape')
  await chooseAgent(page, { agent: 'antigravity', model: MODEL, permissions: 'manual' })

  await page.getByRole('button', { name: 'New conversation' }).click()
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
  const userMessages = page.locator('.bubble.user')
  const agentMessages = page.locator('.bubble.agent')
  const before = await userMessages.count()
  const agentBefore = await agentMessages.count()
  await messageBox(page).fill('Continue after restart')
  await messageBox(page).press('Enter')
  await userMessages.nth(before).waitFor()
  await agentMessages.nth(agentBefore).waitFor()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('a packaged restart resumes the same agy conversation', (await page.locator('.transcript').innerText()).includes(`Resumed ${SESSION}.`))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-antigravity-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF ANTIGRAVITY')
