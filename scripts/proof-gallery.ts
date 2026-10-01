// U5 workflow-gallery gate, run against the PACKAGED app (npm run package first): `npm run proof:gallery`.
// No agent usage: the agent is the stand-in that just answers (scripts/fixtures/echo-agent), and nothing
// here should start it. A project with no workflows points from the new-conversation screen to the gallery;
// the gallery has categories with counts, featured picks, search, and a detail view with the instructions
// file, a suggested schedule or "On demand", the tools it relies on and related workflows. Adding copies a
// workflow paused: its suggested schedule filled in but off, nothing run, nothing scheduled.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { GALLERY, CATEGORIES } from '../web/src/gallery/catalog.ts'
import { featured } from '../web/src/gallery/gallery.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

interface Flow { name: string; title?: string; collection?: string; enabled: boolean; nextRunAt: string | null; intervalMinutes: number | null
  calendar: { days: number[]; time: string; timeZone: string } | null; settings: { permissionMode: string }; lastThreadId?: string }

const project = join(mkdtempSync(join(tmpdir(), 'cockpit-gallery-proof-')), 'gallery-demo')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# gallery demo\n')
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const flows = (page: Page): Promise<Flow[]> => getJson<Flow[]>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`)
const threadCount = async (page: Page): Promise<number> => (await getJson<unknown[]>(page, '/api/threads')).length

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

try {
  await openProject(page, project, 'Gallery demo')
  const pointer = page.getByRole('button', { name: /Doing the same job often\?/ })
  await pointer.waitFor()
  check('a project with no workflows points to the gallery from the new-conversation screen', true)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-gallery-pointer.png') })
  await pointer.click()

  const gallery = page.getByRole('main', { name: 'Workflow gallery' })
  await gallery.waitFor()
  check('the pointer opens Workflows on the gallery', await page.getByRole('tab', { name: 'Workflows', exact: true }).getAttribute('aria-selected') === 'true')
  const tabs = gallery.getByRole('tablist', { name: 'Categories' }).getByRole('tab')
  const labels = (await tabs.allTextContents()).map((t) => t.trim())
  const expected = ['All', ...CATEGORIES].map((c) => `${c} ${c === 'All' ? GALLERY.length : GALLERY.filter((w) => w.category === c).length}`)
  check('categories with counts, All first', JSON.stringify(labels) === JSON.stringify(expected), labels.join(' | '))
  const picks = await gallery.getByRole('region', { name: 'Featured' }).locator('.gallery-card strong').allTextContents()
  check('featured picks lead the page', JSON.stringify(picks) === JSON.stringify(featured().map((w) => w.title)), picks.join(', '))
  check('every workflow is listed under its category', await gallery.locator('.gallery-section:not([aria-label="Featured"]) .gallery-card').count() === GALLERY.length)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-gallery.png') })

  const search = gallery.getByRole('searchbox', { name: 'Search the gallery' })
  await search.fill('changelog tag')
  check('search narrows to matches and hides featured', JSON.stringify(await gallery.locator('.gallery-card strong').allTextContents()) === JSON.stringify(['Changelog since the last tag'])
    && await gallery.getByRole('region', { name: 'Featured' }).count() === 0)
  await search.fill('nothing could match this')
  check('an empty search says so', await gallery.getByText('Nothing in the gallery matches.').isVisible())
  await search.fill('')
  await gallery.getByRole('tab', { name: /^Run and debug/ }).click()
  const run = await gallery.locator('.gallery-card strong').allTextContents()
  check('a category tab shows only that category', run.length === GALLERY.filter((w) => w.category === 'Run and debug').length && run.includes('Build report'), run.join(', '))

  // A tool-dependent, scheduled workflow: detail view.
  await gallery.getByRole('tab', { name: /^All/ }).click()
  await gallery.locator('.gallery-section[aria-label="Mail, calendar and web"] .gallery-card').filter({ hasText: 'Morning brief' }).click()
  const detail = page.getByRole('main', { name: 'Morning brief in the gallery' })
  await detail.waitFor()
  const brief = GALLERY.find((w) => w.name === 'morning-brief')!
  check('detail shows the instructions file', await detail.getByText('morning-brief.md').isVisible()
    && (await detail.getByLabel('Instructions').textContent()) === brief.prompt)
  check('detail shows the suggested schedule', await detail.getByText('Weekdays at 08:00, suggested').isVisible())
  check('detail names the tools it relies on', await detail.getByRole('note').getByText('Relies on read access to your calendar and read access to your email.').isVisible())
  const related = await detail.getByRole('region', { name: 'Related workflows' }).locator('.gallery-card strong').allTextContents()
  check('detail lists related workflows, not itself', related.length === 3 && !related.includes('Morning brief') && related.includes('Meeting prep'), related.join(', '))
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  await page.screenshot({ path: join(PROOF_DIR, 'proof-gallery-detail-dark.png') })
  await page.evaluate(() => { delete document.documentElement.dataset.theme; document.documentElement.style.colorScheme = '' })

  // Related → an on-demand repository workflow.
  await detail.getByRole('region', { name: 'Related workflows' }).locator('.gallery-card').filter({ hasText: 'Meeting prep' }).click()
  const prep = page.getByRole('main', { name: 'Meeting prep in the gallery' })
  await prep.waitFor()
  check('a related workflow opens its own detail; on demand says so', await prep.locator('.gallery-facts').getByText('On demand', { exact: true }).isVisible())
  await prep.getByRole('button', { name: 'Gallery' }).click()
  await gallery.locator('.gallery-section[aria-label="Git and handoffs"] .gallery-card').filter({ hasText: 'Standup notes' }).click()
  const standup = page.getByRole('main', { name: 'Standup notes in the gallery' })
  check('a repository workflow needs no outside tools', await standup.getByText('This project’s folder').isVisible() && await standup.getByRole('note').count() === 0)

  const before = await threadCount(page)
  await standup.getByRole('button', { name: 'Add to Workflows', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'Standup notes' }).waitFor()
  const copy = (await flows(page)).find((w) => w.name === 'standup-notes')
  check('Add copies it into the project under its category', copy?.title === 'Standup notes' && copy.collection === 'Git and handoffs'
    && copy.settings.permissionMode === 'plan')
  check('the copy is paused, with the suggested schedule filled in but off', copy?.enabled === false && copy.nextRunAt === null
    && JSON.stringify(copy.calendar) === JSON.stringify({ days: [1, 2, 3, 4, 5], time: '09:00', timeZone: zone }))
  check('the editor opens on the copy, schedule ready to turn on', await page.getByLabel('Repeat', { exact: true }).inputValue() === 'weekdays'
    && await page.getByLabel('At', { exact: true }).inputValue() === '09:00'
    && await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).isEnabled())
  check('the list says it is paused', await page.locator('.workflow-row').filter({ hasText: 'Paused · Weekdays at 09:00' }).isVisible())

  await page.getByRole('button', { name: /^Workflow gallery/ }).click()
  await gallery.locator('.gallery-section[aria-label="Git and handoffs"] .gallery-card').filter({ hasText: 'Standup notes' }).click()
  check('the gallery marks what is already added', await page.getByText('Already in Gallery demo.', { exact: false }).isVisible())
  await page.getByRole('button', { name: 'Add another copy', exact: true }).click()
  await page.locator('.workflow-slug').filter({ hasText: '@workflow:standup-notes-2' }).waitFor()
  check('adding again makes a second copy with its own reference name', (await flows(page)).filter((w) => w.name.startsWith('standup-notes')).length === 2)

  await page.waitForTimeout(6_000) // longer than one scheduler tick
  const after = await flows(page)
  check('adding never runs or schedules anything', await threadCount(page) === before && after.every((w) => !w.enabled && !w.nextRunAt && !w.lastThreadId),
    `${await threadCount(page) - before} new conversations`)

  await page.getByRole('tab', { name: 'Conversations', exact: true }).click()
  await page.getByRole('heading', { name: 'What are you working on?' }).waitFor()
  await page.waitForTimeout(1_500) // the screen checks the project's workflows after it mounts
  check('once the project has workflows the pointer goes away', await pointer.count() === 0)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-gallery-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF GALLERY')
