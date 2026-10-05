// Packaged gate for wave 7. So far: W7.1 A12 (workflow conversation titles) and F16 (+ New workflow from the
// new-conversation screen). Stand-in agents only (scripts/fixtures/wave65-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-7
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave7-proof-'))
const project = join(root, 'app')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave7-${name}.png`) })
const get = <T>(page: Page, path: string): Promise<T> => page.evaluate(async (p) => (await (await fetch(p)).json()).data, path) as Promise<T>
const workflowCount = async (page: Page) => (await get<unknown[]>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`)).length
const threadTitles = async (page: Page) => (await get<Array<{ meta: { title: string } }>>(page, '/api/threads')).map((t) => t.meta.title)
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Wave 7')
  const review = await apiPost(page, '/api/workflows', { projectPath: project, name: 'review', title: 'Code review', prompt: 'Review the changes' }) as { data: { id: string } }
  await page.reload()
  await page.getByRole('button', { name: 'New conversation' }).click()
  // A project opened for the first time offers its recent work; Start fresh is the plain empty state.
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click()

  // F16 / W7-02: + New workflow beside Browse workflows; the editor opens with its instructions focused, the draft stays.
  const links = page.locator('.workflow-card-links')
  check('W7-02 + New workflow sits beside Browse workflows', await links.getByRole('button', { name: 'Browse workflows →' }).isVisible()
    && await links.getByRole('button', { name: '+ New workflow' }).isVisible())
  await shot(page, 'start-links')
  await messageBox(page).fill('half-typed idea about the login page')
  await links.getByRole('button', { name: '+ New workflow' }).click()
  const editor = page.locator('.workflow-editor')
  await editor.waitFor()
  check('W7-02 the editor opens on the new-conversation screen', await page.locator('.new-conversation .workflow-editor').isVisible())
  check('W7-02 its instructions have focus', await until('instructions focus', () => page.evaluate(() => Boolean(document.activeElement?.closest('.workflow-doc')))))
  check('W7-02 it only saves: no run or schedule from here', await editor.getByRole('button', { name: 'Save and run' }).count() === 0
    && await editor.getByRole('button', { name: 'Save and enable schedule' }).count() === 0)
  await shot(page, 'editor-open')

  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  check('W7-02 Cancel saves nothing', await workflowCount(page) === 1)
  check('W7-02 Cancel restores the draft and the focus', await messageBox(page).inputValue() === 'half-typed idea about the login page'
    && await until('composer focus', () => messageBox(page).evaluate((el) => el === document.activeElement)))

  await links.getByRole('button', { name: '+ New workflow' }).click()
  await editor.getByLabel('Title', { exact: true }).fill('Release notes')
  await editor.getByLabel('Reference name', { exact: true }).fill('release-notes')
  await editor.locator('.workflow-doc .ProseMirror').click()
  await page.keyboard.type('Write the release notes')
  await editor.getByRole('button', { name: 'Save workflow', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  check('W7-02 Save creates exactly one workflow', await until('one saved', async () => await workflowCount(page) === 2))
  check('W7-02 Save starts nothing', (await threadTitles(page)).length === 0)
  check('W7-02 the draft and focus come back after Save', await messageBox(page).inputValue() === 'half-typed idea about the login page'
    && await until('composer focus', () => messageBox(page).evaluate((el) => el === document.activeElement)))
  check('W7-02 the new workflow is offered as a card', await until('card', () => page.locator('.workflow-card', { hasText: 'Release notes' }).isVisible()))

  // A12 / W7-01: a conversation started from a workflow card is "@<workflow>"; a manual run uses the same rule.
  await messageBox(page).fill('')
  await page.locator('.workflow-card', { hasText: 'Code review' }).click()
  await messageBox(page).press('End')
  await messageBox(page).pressSequentially(' for the login page')
  await messageBox(page).press('Enter')
  check('W7-01 a card-started conversation is titled @Code review in the header', await until('header title',
    async () => (await page.locator('.thread-head h1').textContent())?.trim() === '@Code review'))
  check('W7-01 and in the list', await page.getByRole('navigation', { name: 'Conversations' }).getByText('@Code review', { exact: true }).first().isVisible())
  await shot(page, 'card-title')
  await apiPost(page, `/api/workflows/${review.data.id}/run`, {}).catch(() => undefined)
  check('W7-01 a manual run uses the same title', await until('run title', async () => (await threadTitles(page)).filter((t) => t === '@Code review').length >= 1))

  for (const theme of ['Light', 'Dark'] as const) {
    await setTheme(page, theme)
    await page.getByRole('button', { name: 'New conversation' }).click()
    const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
    if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
    await page.locator('.workflow-card-links').getByRole('button', { name: '+ New workflow' }).click()
    await shot(page, `editor-${theme.toLowerCase()}`)
    await page.locator('.workflow-editor').getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await page.setViewportSize({ width: 980, height: 760 })
  await shot(page, 'start-narrow')
  check('narrow: the link row stays inside the start screen', await page.locator('.workflow-card-links').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
} catch (error) {
  console.log(`FAIL  unexpected: ${error instanceof Error ? error.message : String(error)}`)
  await shot(page, 'failure').catch(() => undefined)
  console.log('  alerts:', await page.getByRole('alert').allTextContents().catch(() => []))
  console.log('  doc:', await page.locator('.workflow-doc .ProseMirror').textContent().catch(() => '?'))
  check('proof ran to the end', false)
} finally {
  await app.close()
}
finish('PROOF WAVE 7')
