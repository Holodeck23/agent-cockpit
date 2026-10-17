// W13 Project Settings for the user's own Claude memory and skills, run against the PACKAGED proof app
// in the background: `COCKPIT_PROOF_BACKGROUND=1 tsx scripts/proof-w13-settings-ui.ts`. No agent usage.
// A private synthetic default profile stands in for ~/.claude. Nothing chosen, then chosen, then changed
// since chosen (review again), chosen again, a linked skill reviewed and included, then left out again,
// and stopped; light, dark and narrow captures of each.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { claudeProjectSlug } from '../server/agents/setup/claude-inventory.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

if (process.env.COCKPIT_PROOF_BACKGROUND !== '1') throw new Error('Run with COCKPIT_PROOF_BACKGROUND=1: this proof must stay in the background')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-w13-settings-ui-')))
const state = join(home, 'state'), project = join(home, 'bakery-site'), profile = join(home, 'default-claude'), elsewhere = join(home, 'elsewhere')
mkdirSync(project); writeFileSync(join(project, 'README.md'), '# demo\n')
const memoryDir = join(profile, 'projects', claudeProjectSlug(project), 'memory')
const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }) }
write(join(memoryDir, 'MEMORY.md'), '# Bakery memory\n\n- [Deploys](deploys.md): how the shop goes live\n')
write(join(memoryDir, 'deploys.md'), 'Deploys go out from main after the tests pass.\n')
write(join(profile, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship the site.\n---\nRun the deploy script.\n')
write(join(profile, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change.\n---\nRead the diff.\n')
write(join(profile, 'commands', 'standup.md'), 'Summarise yesterday.\n')
write(join(profile, 'agents', 'helper.md'), '---\nname: helper\ndescription: A helper.\n---\nHelp.\n')
write(join(elsewhere, 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: Linked in.\n---\nShared.\n')
symlinkSync(join(elsewhere, 'shared-skill'), join(profile, 'skills', 'shared-skill'))
execFileSync('chmod', ['-R', 'go-rwx', profile])

const { check, finish } = checker()
const out = (name: string): string => join(PROOF_DIR, `w13-settings-ui-${name}.png`)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/ask-agent'), COCKPIT_PROOF_DEFAULT_CLAUDE_PROFILE: profile })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

const group = (page: Page) => page.locator('.claude-setup-group')
const memory = (page: Page) => page.getByRole('group', { name: 'Claude memory' })
const skills = (page: Page) => page.getByRole('group', { name: 'Your Claude skills' })
const theme = (page: Page, mode: 'light' | 'dark') => page.evaluate((m) => { document.documentElement.dataset.theme = m }, mode)
/** The window regains focus: the settings re-read both choices, as when the user comes back from a terminal. */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))
async function capture(page: Page, name: string): Promise<void> {
  for (const mode of ['light', 'dark'] as const) {
    await theme(page, mode)
    await group(page).scrollIntoViewIfNeeded()
    await group(page).screenshot({ path: out(`${name}-${mode}`) })
  }
}

try {
  check('the app is in the background, not focusable', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isFocusable())))
  await openProject(page, project, 'Bakery site')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Bakery site settings…' }).click()
  await memory(page).waitFor()

  check('nothing chosen: memory says so and offers the CLI default', await memory(page).getByText('Not loading any memory.').isVisible()
    && await memory(page).getByRole('button', { name: 'Use this memory' }).first().isEnabled())
  const offer = await skills(page).innerText()
  check('nothing chosen: skills on offer are counted', offer.includes('On offer: 2 skills, 1 command, 1 agent.'), offer)
  const linkTarget = join(elsewhere, 'shared-skill')
  const include = skills(page).getByRole('checkbox', { name: /skills\/shared-skill/ })
  check('the linked skill is offered for review, unticked, with where it points', offer.includes('Linked from elsewhere (1).')
    && offer.includes(`links to ${linkTarget}`) && !await include.isChecked(), offer)
  const text = await group(page).innerText()
  check('no folder path is shown but where the link points', !text.replaceAll(linkTarget, '').includes(home) && !text.includes('/Users/'))
  await capture(page, '1-none')

  await memory(page).getByRole('button', { name: 'Use this memory' }).first().click()
  await memory(page).getByText(/^Loading CLI default, 2 files, chosen/).waitFor()
  await skills(page).getByRole('button', { name: 'Use my skills' }).click()
  await skills(page).getByText(/^Loading 2 skills, 1 command, 1 agent, chosen/).waitFor()
  check('chosen: both say what loads, and offer to stop', await memory(page).getByText('Chosen', { exact: true }).isVisible()
    && await page.getByRole('button', { name: 'Stop loading memory' }).isVisible() && await page.getByRole('button', { name: 'Stop loading my skills' }).isVisible())
  await capture(page, '2-chosen')

  // The CLI changes both after they were chosen.
  write(join(memoryDir, 'deploys.md'), 'Deploys go out from main after the tests pass and a review.\n')
  write(join(profile, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship the site.\n---\nRun the deploy script, then check the shop.\n')
  await refocus(page)
  await memory(page).getByRole('alert').filter({ hasText: 'Changed since you chose it' }).waitFor()
  await skills(page).getByRole('alert').filter({ hasText: 'Changed since you chose them' }).waitFor()
  check('changed since chosen: both ask for another review', await memory(page).getByRole('button', { name: 'Use the current memory' }).isVisible()
    && await skills(page).getByRole('button', { name: 'Use the current version' }).isVisible())
  await capture(page, '3-changed')

  await page.setViewportSize({ width: 760, height: 720 })
  for (const mode of ['light', 'dark'] as const) {
    await theme(page, mode)
    await group(page).scrollIntoViewIfNeeded()
    await page.screenshot({ path: out(`4-narrow-${mode}`), mask: [page.locator('.modal-path'), page.getByText(/^Checkout:/)] })
  }
  const overflow = await page.locator('.project-settings-scroll').evaluate((el) => {
    const edge = el.getBoundingClientRect().right
    const widest = [...el.querySelectorAll('*')].map((child) => ({ child, over: child.getBoundingClientRect().right - edge })).sort((a, b) => b.over - a.over)[0]
    // Inline, not a named helper: the bundler's name wrapper does not exist in the page.
    const parent = widest?.child.parentElement
    return { by: el.scrollWidth - el.clientWidth, widest: widest && widest.over > 0
      ? `${widest.child.tagName.toLowerCase()} in ${parent?.tagName.toLowerCase()}.${parent?.className}: "${(widest.child.textContent ?? '').slice(0, 24)}"` : 'none' }
  })
  check('narrow: no sideways scroll in the settings', overflow.by <= 0, `${overflow.by}px, widest ${overflow.widest}`)
  await page.setViewportSize({ width: 1280, height: 860 })

  await memory(page).getByRole('button', { name: 'Use the current memory' }).click()
  await skills(page).getByRole('button', { name: 'Use the current version' }).click()
  await memory(page).getByText(/^Loading CLI default, 2 files, chosen/).waitFor()
  await skills(page).getByText(/^Loading 2 skills, 1 command, 1 agent, chosen/).waitFor()
  check('reviewed again: both are current', await page.getByRole('alert').filter({ hasText: 'Changed since' }).count() === 0)

  // Reviewed where it points, the linked skill is ticked and the choice updated to include it.
  check('nothing to update until a tick changes', await skills(page).getByRole('button', { name: 'Update my choice' }).count() === 0)
  await include.check()
  await skills(page).getByRole('button', { name: 'Update my choice' }).click()
  await skills(page).getByText(/^Loading 3 skills, 1 command, 1 agent, with 1 linked entry, chosen/).waitFor()
  check('included: the link loads and stays ticked', await include.isChecked() && await skills(page).getByRole('button', { name: 'Update my choice' }).count() === 0)
  await capture(page, '5-linked')
  await include.uncheck()
  await skills(page).getByRole('button', { name: 'Update my choice' }).click()
  await skills(page).getByText(/^Loading 2 skills, 1 command, 1 agent, chosen/).waitFor()
  check('left out again: back to the profile alone', !await include.isChecked())

  await page.getByRole('button', { name: 'Stop loading memory' }).click()
  await memory(page).getByText('Not loading any memory.').waitFor()
  await page.getByRole('button', { name: 'Stop loading my skills' }).click()
  await skills(page).getByText('Not loading your skills.').waitFor()
  check('stopped: neither loads', true)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: out('failure'), mask: [page.locator('.modal-path')] }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF W13 SETTINGS UI')
