// Checkpoint 4 gate (workflow discovery), PACKAGED app: `npm run proof:discovery`. No agent usage.
// Seeds an old-format workflow (no title), a scheduled one and a titled one; then search, views,
// collections, adding from the gallery (saved paused, never run), and renaming a title without breaking
// the @workflow: reference.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createWorkflowStore, expandWorkflows } from '../server/workflows/store.ts'
import { checker, EXECUTABLE, LAUNCHD_PATH, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const state = mkdtempSync(join(tmpdir(), 'cockpit-discovery-proof-'))
const project = join(state, 'discovery-project')
mkdirSync(project)
const now = new Date().toISOString()
const base = { projectPath: project, settings: { agent: 'claude', permissionMode: 'plan', useHooks: false }, createdAt: now, updatedAt: now, archived: false }
writeFileSync(join(state, 'workflows.json'), JSON.stringify([
  { ...base, id: randomUUID(), name: 'legacy-brief', prompt: 'Summarise the README.', intervalMinutes: null, enabled: false, nextRunAt: null },
  { ...base, id: randomUUID(), name: 'nightly-check', title: 'Nightly check', collection: 'Quality', prompt: 'Run the tests and report.', intervalMinutes: 1440, enabled: true, nextRunAt: new Date(Date.now() + 86_400_000).toISOString() },
  { ...base, id: randomUUID(), name: 'bug-hunt', title: 'Bug hunt', collection: 'Quality', prompt: 'Look for off-by-one errors in the parser.', intervalMinutes: null, enabled: false, nextRunAt: null },
], null, 2), { mode: 0o600 })
mkdirSync(PROOF_DIR, { recursive: true })

const app = await electron.launch({ executablePath: EXECUTABLE,
  env: { ...process.env, COCKPIT_HOME: state, PATH: LAUNCHD_PATH } })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Discovery proof')
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  const list = page.getByRole('navigation', { name: 'Saved workflows' })
  const titles = async (): Promise<string[]> => list.locator('.workflow-row strong').allTextContents()
  await list.locator('.workflow-row').first().waitFor()
  check('an old workflow without a title still lists, under its name', (await titles()).includes('legacy-brief'))
  check('collections group the list, ungrouped last', JSON.stringify(await list.locator('.workflow-group-title').allTextContents()) === JSON.stringify(['Quality', 'Other']))

  await list.getByRole('searchbox', { name: 'Search workflows' }).fill('off-by-one')
  check('search matches instructions', JSON.stringify(await titles()) === JSON.stringify(['Bug hunt']), (await titles()).join(', '))
  await list.getByRole('searchbox', { name: 'Search workflows' }).fill('no such thing')
  check('an empty search says so', await list.getByText('No workflows match.').isVisible())
  await list.getByRole('searchbox', { name: 'Search workflows' }).fill('')
  await list.getByRole('tab', { name: /Scheduled/ }).click()
  check('Scheduled shows only enabled workflows', JSON.stringify(await titles()) === JSON.stringify(['Nightly check']), (await titles()).join(', '))
  await list.getByRole('tab', { name: /Manual/ }).click()
  check('Manual shows the rest', (await titles()).length === 2 && !(await titles()).includes('Nightly check'))
  await list.getByRole('tab', { name: /All/ }).click()

  const addFocusedReview = async (button: string): Promise<void> => {
    await list.getByRole('button', { name: /^Workflow gallery/ }).click()
    await page.locator('.gallery-section[aria-label="Quality"] .gallery-card').filter({ hasText: 'Focused review' }).click()
    await page.getByRole('button', { name: button, exact: true }).click()
  }
  await addFocusedReview('Add to Workflows')
  await list.locator('.workflow-row').filter({ hasText: 'Focused review' }).waitFor()
  await addFocusedReview('Add another copy')
  await list.locator('.workflow-slug').filter({ hasText: '@workflow:focused-review-2' }).waitFor()
  const store = createWorkflowStore(state)
  const copies = store.list(project).filter((w) => w.name.startsWith('focused-review'))
  check('adding from the gallery twice makes two copies with distinct reference names', JSON.stringify(copies.map((w) => w.name).sort()) === JSON.stringify(['focused-review', 'focused-review-2']))
  check('gallery copies are saved paused and unscheduled', copies.every((w) => !w.enabled && w.nextRunAt === null && w.intervalMinutes === null && w.settings.permissionMode === 'plan'))
  const threads = await page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: unknown[] }).data.length)
  check('adding from the gallery never runs them', threads === 0 && copies.every((w) => !w.lastThreadId), `${threads} conversations`)
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-4-workflows.png') })

  await list.locator('.workflow-row').filter({ hasText: 'Bug hunt' }).click()
  const editor = page.locator('.workflow-editor')
  check('a saved reference name is read-only', await editor.getByLabel('Reference name', { exact: true }).evaluate((el) => (el as HTMLInputElement).readOnly))
  await editor.getByLabel('Title', { exact: true }).fill('Parser bug hunt')
  await editor.getByRole('button', { name: 'Save workflow', exact: true }).click()
  await list.locator('.workflow-row').filter({ hasText: 'Parser bug hunt' }).waitFor()
  const renamed = store.list(project).find((w) => w.name === 'bug-hunt')
  check('the title changes and the reference still resolves', renamed?.title === 'Parser bug hunt' &&
    expandWorkflows('@workflow:bug-hunt', project, store).includes('off-by-one errors'))
} finally {
  await app.close()
}
finish('DISCOVERY')
