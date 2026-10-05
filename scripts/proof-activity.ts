// Checkpoint 1 gate (activity pane), run against the PACKAGED app: `npm run proof:activity`.
// Synthetic part (no agent usage): a recorded multi-tool Claude run and a second conversation
// with an interrupted call. The pane must list exactly each conversation's tool calls, never
// leak between them, keep approvals and answers in the conversation, remember its width and
// open state across a restart, replay identically, and float over the conversation when narrow.
// Live part (skip with --no-live, a few cents): one real Codex dev-server run with the pane open;
// the approval stays actionable in the conversation and the pane fills as the agent works.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { parseClaudeLine } from '../server/agents/claude/parse.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { DEV_PROMPT, makeDevProject } from './lib/dev-fixture.ts'
import { checker, EXECUTABLE, LAUNCHD_PATH, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { chooseAgent, openProject, startConversation } from './lib/ui.ts'

const live = !process.argv.includes('--no-live')
const codexModel = process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna'
const { check, finish } = checker()

const state = mkdtempSync(join(tmpdir(), 'cockpit-activity-proof-'))
const project = join(state, 'activity-project')
mkdirSync(project)
const store = createThreadStore(state)

function seed(title: string, events: readonly NormalizedEvent[]): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  store.create({ id, title, projectPath: project, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(),
    sessionStarted: true, completed: false, createdAt: now, updatedAt: now })
  for (const event of events) store.append(id, event)
  return id
}

const recorded = readFileSync(join(ROOT, 'tests/fixtures/claude-turn-approval.jsonl'), 'utf8').split('\n').flatMap(parseClaudeLine)
const recordedTools = recorded.filter((e) => e.kind === 'tool_use').length
seed('Recorded approval run', [{ kind: 'user_text', text: 'Write the notes file' }, ...recorded])
seed('Interrupted search', [
  { kind: 'user_text', text: 'Find the TODOs' },
  { kind: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'TODO' } },
  { kind: 'tool_result', toolUseId: 'g1', content: 'src/a.ts:3: TODO tidy', isError: false },
  { kind: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
  { kind: 'tool_result', toolUseId: 'b1', content: 'Error: 1 failing', isError: true },
  { kind: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'sleep 300' } },
  { kind: 'result', ok: false, stopped: true },
])

const launch = (): Promise<ElectronApplication> => electron.launch({
  executablePath: EXECUTABLE,
  env: { ...process.env, COCKPIT_HOME: state, PATH: LAUNCHD_PATH },
})

interface RowView { label: string; state: string }
async function paneRows(page: Page): Promise<RowView[]> {
  return page.locator('.activity-row').evaluateAll((rows) => rows.map((row) => ({
    label: row.querySelector('.activity-label')?.textContent ?? '',
    state: row.querySelector('.activity-state')?.textContent ?? '',
  })))
}
const pane = (page: Page) => page.getByRole('complementary', { name: 'Activity' })
async function openConversation(page: Page, title: string): Promise<void> {
  await page.locator('.card').filter({ hasText: title }).click()
  await page.locator('.thread h1').filter({ hasText: title }).waitFor()
}

mkdirSync(PROOF_DIR, { recursive: true })
let app = await launch()
let firstRows: RowView[] = []
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1360, height: 860 })
  await openConversation(page, 'Recorded approval run')
  check('the pane starts closed, with steps in the conversation', (await pane(page).count()) === 0 && (await page.locator('.step').count()) === recordedTools)
  await page.keyboard.press('Meta+Shift+A')
  await pane(page).waitFor()
  const recordedRows = await paneRows(page)
  check('⌘⇧A opens the pane with one row per recorded tool call', recordedRows.length === recordedTools, `${recordedRows.length} of ${recordedTools}`)
  check('every recorded call reported back', recordedRows.every((r) => r.state === 'Done' || r.state === 'Failed'), recordedRows.map((r) => r.state).join(', '))
  check('tool steps leave the conversation while the pane is open', (await page.locator('.events .step').count()) === 0)
  check('answers and the approval card stay in the conversation',
    (await page.locator('.events .bubble.agent').count()) > 0 && (await page.locator('.events .approval').count()) > 0)
  await pane(page).locator('.activity-row summary').first().click()
  await pane(page).locator('.activity-detail pre').first().waitFor()
  check('a row expands to show its input and output', (await pane(page).locator('.activity-row details[open] pre').count()) >= 1)
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-1-activity.png') })

  await openConversation(page, 'Interrupted search')
  firstRows = await paneRows(page)
  check('switching conversations shows only that conversation\'s calls', JSON.stringify(firstRows) === JSON.stringify([
    { label: 'Searching for “TODO”', state: 'Done' },
    { label: 'Running npm test', state: 'Failed' },
    { label: 'Running sleep 300', state: 'Interrupted' },
  ]), JSON.stringify(firstRows))
  check('an interrupted call says it never reported back',
    await pane(page).locator('.activity-interrupted .activity-none').evaluate((el) => (el.textContent ?? '').includes('No result')).catch(() => false) ||
    (await pane(page).locator('.activity-interrupted .activity-none').count()) === 1)

  const handle = page.getByRole('separator', { name: 'Resize activity' })
  const before = Number(await handle.getAttribute('aria-valuenow'))
  await handle.focus()
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft')
  const after = Number(await handle.getAttribute('aria-valuenow'))
  check('the resize handle works from the keyboard', after === before + 48, `${before} → ${after}`)
  const box = await handle.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + 200, { steps: 4 })
    await page.mouse.up()
  }
  const dragged = Number(await handle.getAttribute('aria-valuenow'))
  check('the resize handle works by dragging', dragged === after + 40, `${after} → ${dragged}`)
} finally {
  await app.close()
}

app = await launch()
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1360, height: 860 })
  await openConversation(page, 'Interrupted search')
  await pane(page).waitFor()
  check('the pane is still open after a restart', true)
  const width = Number(await page.getByRole('separator', { name: 'Resize activity' }).getAttribute('aria-valuenow'))
  check('its width survived the restart', width === 340 + 48 + 40, String(width))
  check('replay after restart matches', JSON.stringify(await paneRows(page)) === JSON.stringify(firstRows))

  await page.setViewportSize({ width: 980, height: 700 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  const floating = await pane(page).evaluate((el) => getComputedStyle(el).position)
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  check('at minimum window width the pane floats over the conversation without page scroll',
    floating === 'absolute' && (widths[0] ?? 0) <= (widths[1] ?? 0), `${floating}, ${widths.join(' / ')}`)
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-1-activity-narrow-dark.png') })
  await page.getByRole('button', { name: 'Close activity' }).click()
  check('closing the pane brings the steps back into the conversation', (await page.locator('.events .step').count()) === 3)
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await pane(page).waitFor()
  await page.evaluate(() => { delete document.documentElement.dataset.theme; document.documentElement.style.colorScheme = '' })
  await page.setViewportSize({ width: 1360, height: 860 })

  if (live) {
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __opened?: string[] }).__opened = opened
      shell.openExternal = async (url: string) => void opened.push(url)
    })
    const dev = makeDevProject('cockpit-activity-dev-')
    await openProject(page, dev, 'Activity live')
    await chooseAgent(page, { agent: 'codex', model: codexModel, permissions: 'manual' })
    await startConversation(page, DEV_PROMPT)
    await pane(page).waitFor()
    const card = page.locator('.events .approval.open').first()
    await card.waitFor({ timeout: 180_000 })
    check('with the pane open, the approval card is in the conversation and actionable',
      (await card.getByRole('button', { name: 'Allow', exact: true }).isEnabled()) && (await pane(page).locator('.approval').count()) === 0)
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
    await page.locator('.thread-status .status-text').filter({ hasText: /Ready|Error|Waiting/ }).waitFor({ timeout: 180_000 })
    const liveRows = await paneRows(page)
    check('the live run filled the pane, including the approved start', liveRows.some((r) => r.label.startsWith('Starting') && r.state === 'Done'), liveRows.map((r) => `${r.label} (${r.state})`).join('; '))
    check('the live run ended with no call left running', liveRows.every((r) => r.state !== 'Running'))
    // A real run records this machine's paths, so its screenshot stays out of the repo.
    const liveShot = join(state, 'checkpoint-1-activity-live.png')
    await page.screenshot({ path: liveShot })
    console.log(`live screenshot (private): ${liveShot}`)
  }
} finally {
  await app.close()
}
finish('ACTIVITY')
