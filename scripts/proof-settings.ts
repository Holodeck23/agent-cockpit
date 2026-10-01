// U7 settings-and-sounds gate, run against the PACKAGED app (npm run package first): `npm run proof:settings`.
// No agent usage: the agent is the stand-in that asks for two approvals each turn (scripts/fixtures/ask-agent).
// Sounds are off by default and stay silent; switched on in Settings, a waiting approval plays the decision
// sound and the finished turn plays the reply sound; the choices survive a restart. The app announces each
// sound it plays as a `cockpit:sound` window event, which is what this proof listens for.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject } from './lib/ui.ts'

const home = mkdtempSync(join(tmpdir(), 'cockpit-settings-proof-'))
const project = join(home, 'settings-demo')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# settings demo\n')
const env = { COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/ask-agent') }

/** Starts a fresh record of sounds; the listener is attached once per page load. */
const listen = (page: Page): Promise<void> => page.evaluate(() => {
  const w = window as unknown as { heard?: string[] }
  if (!w.heard) window.addEventListener('cockpit:sound', (e) => w.heard?.push((e as CustomEvent<string>).detail))
  w.heard = []
})
const heard = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { heard: string[] }).heard)
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const toggle = (page: Page, label: string) => dialog(page).getByRole('checkbox', { name: new RegExp(`^${label}`) })

/** One turn of the stand-in: two approvals, each allowed, then the reply. */
async function runTurn(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill(prompt)
  await messageBox(page).press('Enter')
  for (const step of ['echo step 1', 'echo step 2']) {
    const card = page.locator('.approval.open').filter({ hasText: step })
    await card.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(700) // let the status reach the list before answering
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
  }
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1_000)
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
let app: ElectronApplication = await launchPackagedApp(env)
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  await openProject(page, project, 'Settings demo')
  await listen(page)
  await runTurn(page, 'First run with sounds off')
  check('sounds are off by default: a decision and a reply play nothing', JSON.stringify(await heard(page)) === '[]', (await heard(page)).join(', '))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog(page).waitFor()
  check('Settings opens from the top bar with both sounds off', !(await toggle(page, 'When an agent replies').isChecked())
    && !(await toggle(page, 'When an agent needs a decision').isChecked()))
  await toggle(page, 'When an agent replies').check()
  await toggle(page, 'When an agent needs a decision').check()
  await dialog(page).getByRole('button', { name: 'Play the decision sound' }).click()
  check('Play previews a sound', JSON.stringify(await heard(page)) === '["decision"]', (await heard(page)).join(', '))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-settings.png') })
  await page.keyboard.press('Escape')
  check('Escape closes Settings', await dialog(page).count() === 0)

  await listen(page)
  await runTurn(page, 'Second run with sounds on')
  const sounds = await heard(page)
  check('each waiting approval plays the decision sound, the finished turn the reply sound',
    JSON.stringify(sounds) === JSON.stringify(['decision', 'decision', 'reply']), sounds.join(', '))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await toggle(page, 'When an agent replies').uncheck()
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  await app.close()
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  await page.locator('.card').first().waitFor()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  check('sound choices survive a restart', !(await toggle(page, 'When an agent replies').isChecked())
    && await toggle(page, 'When an agent needs a decision').isChecked())
  await page.keyboard.press('Escape')
  await listen(page)
  await runTurn(page, 'Third run, decisions only')
  const third = await heard(page)
  check('with replies off, only decisions sound', JSON.stringify(third) === JSON.stringify(['decision', 'decision']), third.join(', '))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-settings-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF SETTINGS')
