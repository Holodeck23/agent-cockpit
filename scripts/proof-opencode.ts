// OpenCode / OpenRouter gate (U10), PACKAGED app: `npm run proof:opencode`. No agent usage: the
// stand-in (scripts/fixtures/opencode-agent) speaks the Agent Client Protocol as `opencode acp` does.
// Choosing OpenCode with an OpenRouter model reaches the agent's config; Cockpit's instructions and
// MCP tools arrive; a permission request is an approval card (allow and deny); after a restart the
// conversation loads the same session without showing its replayed history twice.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject } from './lib/ui.ts'

const MODEL = 'openrouter/anthropic/claude-sonnet-4'
const home = mkdtempSync(join(tmpdir(), 'cockpit-opencode-proof-'))
const project = join(home, 'notes-app')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# notes\n')
const env = { COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/opencode-agent') }
const meta = (page: Page): Promise<{ sessionId: string; settings: { agent: string; model?: string } }> =>
  page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { sessionId: string; settings: { agent: string; model?: string } } }> }).data[0]!.meta)
async function answer(page: Page, button: 'Allow' | 'Deny'): Promise<string> {
  const card = page.locator('.approval.open')
  await card.waitFor()
  const text = await card.innerText()
  await card.getByRole('button', { name: button, exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  return text
}
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  return { app, page }
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
let { app, page } = await launch()
try {
  await openProject(page, project, 'Notes app')
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByRole('radio', { name: 'OpenCode', exact: true }).click()
  await panel.getByText('0.0.0 (Cockpit opencode fixture)').waitFor()
  check('the picker offers OpenCode and shows it is installed', true)
  await page.keyboard.press('Escape')
  await chooseAgent(page, { agent: 'opencode', model: MODEL, permissions: 'manual' })

  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill('Run the tests please')
  await messageBox(page).press('Enter')
  const card = await answer(page, 'Allow')
  check('a permission request is an approval card naming the command', card.includes('npm test'))
  const first = await page.locator('.transcript').innerText()
  check('the OpenRouter model reaches OpenCode\'s config', first.includes(`Using ${MODEL}`), first.slice(0, 200))
  check('Cockpit\'s instructions and MCP tools arrive', first.includes('instructions received') && first.includes('cockpit tools attached'))
  check('manual permissions become OpenCode\'s "ask"', first.includes('bash ask'))
  check('the allowed step finishes and the reply follows', await page.locator('.step-label').filter({ hasText: 'Running npm test' }).count() === 1 && first.includes('All 3 tests pass.'))
  const saved = await meta(page)
  check('the conversation keeps OpenCode\'s session id and model', saved.sessionId === 'oc-session-1' && saved.settings.agent === 'opencode' && saved.settings.model === MODEL)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-opencode.png') })

  await messageBox(page).fill('And again, but I will say no')
  await messageBox(page).press('Enter')
  await answer(page, 'Deny')
  check('a denied step fails and the agent says so', (await page.locator('.bubble.agent').last().innerText()).includes('Skipped the tests'))
  const denied = await page.locator('.step-label').allInnerTexts()
  check('the denied step reads "Not allowed", not still running', denied.at(-1) === 'Not allowed: running npm test', denied.join(' | '))

  await app.close()
  ;({ app, page } = await launch())
  await page.locator('.card').first().click()
  await messageBox(page).fill('One more time after a restart')
  await messageBox(page).press('Enter')
  await answer(page, 'Allow')
  const after = await page.locator('.transcript').innerText()
  check('after a restart the same OpenCode session is loaded', after.includes('Loaded oc-session-1.'))
  check('its replayed history is not shown twice', !after.includes('replayed history'))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-opencode-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF OPENCODE')
