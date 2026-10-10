// Packaged cross-feature gate for wave 12 (ACCEPTANCE CROSS-01, 02, 08): features from different
// waves used as one flow on the packaged app, with stand-in agents (scripts/fixtures/wave65-agent:
// "ask", "work", START-WEB; Codex answers a handoff with what reached it). No provider usage.
//
//   CROSS-01  queue an image → take it back → answer a question → switch agent → run a host check:
//             the handoff holds the answer and nothing withdrawn; the check is bound to the
//             switched-in agent's run only.
//   CROSS-08  that check passes → the file is changed and committed outside Cockpit → real Quit and
//             reopen: the pass and its output are kept, and it reads stale, never current.
//   CROSS-02  new workflow → immediate ⌘S (one save) → scheduled run → it starts one server
//             (approved on its card) → preview captured on that run's result: one run, one
//             server, owner and receipt bound to the scheduled run.
//
// Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:cross-flow
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject, startConversation, switchWithHandoff } from './lib/ui.ts'

const { check, finish } = checker()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-cross-flow-')))
const state = join(root, 'state'), garden = join(root, 'garden')
mkdirSync(garden)
const ident = { GIT_AUTHOR_NAME: 'Gardener', GIT_AUTHOR_EMAIL: 'g@example.invalid', GIT_COMMITTER_NAME: 'Gardener', GIT_COMMITTER_EMAIL: 'g@example.invalid' }
const git = (...args: string[]): string => execFileSync('git', args, { cwd: garden, encoding: 'utf8', env: { ...process.env, ...ident } }).trim()
git('init', '-q', '-b', 'main')
writeFileSync(join(garden, 'notes.txt'), 'roses\ntulips\n')
git('add', '.')
git('commit', '-q', '-m', 'first')
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png')).toString('base64')
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

const step = (label: string): void => console.log(`  · ${label}`)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `cross-flow-${name}.png`) })
async function until<T>(label: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`  (timed out waiting for ${label})`)
  return undefined
}
const get = <T>(page: Page, path: string): Promise<T> => page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const send = async (page: Page, text: string): Promise<void> => { await messageBox(page).fill(text); await messageBox(page).press('Enter') }
const working = async (page: Page): Promise<boolean> => /Working|Starting/.test((await headStatus(page).textContent()) ?? '')
interface Summary { meta: { id: string; title: string; projectPath: string; workflowTrigger?: string } }
interface Ev { event: { kind: string; text?: string; runId?: string; requestId?: string; toolName?: string } }
interface Check { id: string; runId: string; outcome?: string; freshness?: { state: string; reasons?: string[] }; output?: { evidenceId: string } }
interface Result { runId: string; identity: { agent: string }; checks: Check[]; previews: Array<{ id: string; integrity: string }> }
const threadByTitle = async (page: Page, title: string): Promise<string | undefined> =>
  (await get<Summary[]>(page, '/api/threads')).find((t) => t.meta.title.startsWith(title) && t.meta.projectPath === garden)?.meta.id
const runsOf = async (page: Page, id: string): Promise<string[]> =>
  (await get<{ events: Ev[] }>(page, `/api/threads/${id}/events`)).events.filter((e) => e.event.kind === 'user_text' && e.event.runId).map((e) => e.event.runId!)
const result = (page: Page, threadId: string, runId: string): Promise<Result> => get<Result>(page, `/api/runs/${runId}/result?threadId=${threadId}`)
const openCard = async (page: Page): Promise<Locator> => {
  const card = page.locator('.result-card').last()
  await card.waitFor()
  if (!(await card.getByLabel('Exact command').isVisible().catch(() => false))) await card.locator('summary').click()
  return card
}
const openConversation = async (page: Page, title: string): Promise<void> => {
  await page.getByRole('navigation', { name: 'Conversations' }).getByText(title, { exact: false }).first().click()
}
const launch = (): Promise<ElectronApplication> => launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })

let app: ElectronApplication | undefined
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, garden, 'Garden')

  // ======================= CROSS-01 =======================
  step('CROSS-01 answer a question, queue an image and take it back, switch agent, run a host check')
  await startConversation(page, 'ask')
  const card1 = page.locator('.question-card').last()
  await until('question card', async () => (await card1.locator('.question').count()) === 2)
  await card1.getByRole('radio', { name: /^Blue/ }).check()
  await card1.getByRole('checkbox', { name: /^Small/ }).check()
  await card1.getByRole('button', { name: 'Send answers' }).click()
  await until('answers taken', async () => (await page.locator('.bubble').filter({ hasText: /^Noted:/ }).count()) === 1)
  await send(page, 'work')
  await until('working', () => working(page))
  const thread = (await threadByTitle(page, 'ask'))!
  await apiPost(page, `/api/threads/${thread}/messages`, { text: 'WITHDRAWN-X use Mongo instead', images: [{ data: ICON, name: 'mongo.png' }] })
  const waiting = page.locator('.message.waiting')
  check('CROSS-01 a message with an image waits while the agent works', Boolean(await until('waiting', async () => (await waiting.filter({ hasText: 'WITHDRAWN-X' }).count()) === 1)))
  await waiting.filter({ hasText: 'WITHDRAWN-X' }).getByRole('button', { name: 'Remove' }).click()
  await until('taken back', async () => (await waiting.count()) === 0)
  const chips = page.getByRole('list', { name: 'Images to send' }).locator('li')
  check('CROSS-01 taking it back returns its image to the composer, not to the agent', Boolean(await until('chip', async () => (await chips.count()) === 1)))
  await page.getByRole('button', { name: 'Remove mongo.png' }).click()
  await messageBox(page).fill('')
  await until('turn over', async () => !(await working(page)), 25_000)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const picker = page.getByRole('dialog', { name: 'Agent settings' })
  await picker.getByRole('radio', { name: 'Codex', exact: true }).click()
  await switchWithHandoff(picker)
  await send(page, 'What was chosen?')
  const handoff = page.locator('.bubble').filter({ hasText: /^Handoff: / })
  await until('codex reply', async () => (await handoff.count()) === 1)
  const carried = (await handoff.textContent().catch(() => '')) ?? ''
  check('CROSS-01 the switched-in agent has the answer and nothing withdrawn', carried.includes('answered Blue yes') && carried.includes('withdrawn no') && carried.includes('attached images 0'), carried)
  await until('codex idle', async () => !(await working(page)), 20_000)
  const card = await openCard(page)
  await card.getByLabel('Exact command').fill('cat notes.txt')
  await card.getByLabel('Freshness inputs (comma-separated)').fill('notes.txt')
  await card.getByRole('button', { name: 'Run exactly this check' }).click()
  check('CROSS-01 the host check passes', Boolean(await until('passed', () => card.getByText('Passed', { exact: true }).isVisible())))
  const runs = await runsOf(page, thread)
  const last = runs.at(-1)!
  const mine = await result(page, thread, last)
  const earlier = await Promise.all(runs.slice(0, -1).map((r) => result(page, thread, r)))
  check('CROSS-01 the check is bound to the switched-in agent\'s run, and no earlier run has it',
    mine.identity.agent === 'codex' && mine.checks.length === 1 && mine.checks[0]!.runId === last && mine.checks[0]!.outcome === 'passed' && earlier.every((r) => r.checks.length === 0),
    JSON.stringify({ agent: mine.identity.agent, checks: mine.checks.map((c) => [c.runId === last, c.outcome]), earlier: earlier.map((r) => r.checks.length) }))
  await shot(page, '01-check-on-switched-run')

  // ======================= CROSS-08 =======================
  step('CROSS-08 an outside commit, then a real Quit and reopen')
  const passed = mine.checks[0]!
  writeFileSync(join(garden, 'notes.txt'), 'roses\ntulips\nirises\n')
  git('commit', '-q', '-am', 'irises, outside Cockpit')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openConversation(page, 'ask')
  const reopened = await openCard(page)
  check('CROSS-08 after the restart the old pass reads stale on the card', Boolean(await until('stale', () => reopened.getByText('stale', { exact: true }).first().isVisible())))
  const after = await result(page, thread, last)
  const kept = after.checks.find((c) => c.id === passed.id)
  check('CROSS-08 the pass and its reason are kept, never current: stale because a different commit is checked out',
    kept?.outcome === 'passed' && kept.freshness?.state === 'stale' && (kept.freshness.reasons ?? []).some((r) => /different commit/.test(r)), JSON.stringify(kept?.freshness))
  const evidence = kept?.output ? await page.evaluate(async (p) => (await fetch(p)).status, `/api/runs/${last}/evidence/${kept.output.evidenceId}?threadId=${thread}`) : 0
  check('CROSS-08 its stored output is still there to read', evidence === 200, String(evidence))
  await shot(page, '08-stale-after-restart')

  // ======================= CROSS-02 =======================
  step('CROSS-02 a new workflow saved at once, then its scheduled run starts the site')
  const saves: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/workflows') saves.push(r.postData() ?? '') })
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Create a workflow', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('Garden site')
  await page.getByLabel('Reference name', { exact: true }).fill('garden-site')
  const instructions = 'START-WEB: serve the garden folder so it can be looked at.'
  // Instructions are a document (as in proof:wave-6.5 R2): typed into, then ⌘S at once.
  await page.locator('.workflow-doc .ProseMirror').click()
  // Diagnostics for the unexplained 10-08 miss (one typed character absent from the saved text, not
  // reproduced in 100 trials): record every key and the document after it, so a recurrence shows
  // whether the editor lost it (here) or the save did (the check after ⌘S).
  await page.evaluate(() => {
    const doc = document.querySelector('.workflow-doc .ProseMirror')!
    const log: Array<{ t: number; type: string; key?: string; text: string }> = []
    ;(window as unknown as { proofTyping: typeof log }).proofTyping = log
    for (const type of ['keydown', 'beforeinput', 'input'] as const) {
      doc.addEventListener(type, (e) => log.push({ t: performance.now(), type, ...(e instanceof KeyboardEvent ? { key: e.key } : {}), text: (doc as HTMLElement).innerText }), true)
    }
  })
  await page.keyboard.type(instructions)
  const typed = (await page.locator('.workflow-doc .ProseMirror').innerText()).trim()
  check('CROSS-02 the document holds every typed character before ⌘S', typed === instructions, typed)
  await page.keyboard.press('Meta+s')
  const savedOnce = await until('one save', async () => saves.length === 1 && saves)
  if (typed !== instructions || !saves.join('').includes(JSON.stringify(instructions).slice(1, -1))) {
    writeFileSync(join(PROOF_DIR, 'cross02-typing.json'), JSON.stringify({ instructions, typed, saves,
      keys: await page.evaluate(() => (window as unknown as { proofTyping: unknown[] }).proofTyping) }, null, 2))
  }
  await page.waitForTimeout(800)
  const flows = await get<Array<{ name: string; title: string; instructions?: string; body?: string }>>(page, `/api/workflows?projectPath=${encodeURIComponent(garden)}`)
  const flow = flows.find((f) => f.name === 'garden-site')
  check('CROSS-02 ⌘S right away saves it once, with the text just typed', Boolean(savedOnce) && saves.length === 1 && flow?.title === 'Garden site' && JSON.stringify(flow).includes(instructions), `${saves.length} save(s)`)
  const target = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000)
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly')
  const days = page.getByRole('group', { name: 'Days' })
  await days.getByRole('button', { name: DAY[target.getDay()]!, exact: true }).click()
  if (target.getDay() !== 1) await days.getByRole('button', { name: 'Mon', exact: true }).click()
  await page.getByLabel('At', { exact: true }).fill(hhmm(target))
  await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).click()
  await page.getByText(/^Scheduled · /).first().waitFor()
  const ranId = await until('the scheduled run', async () => {
    const t = (await get<Summary[]>(page, '/api/threads')).find((s) => s.meta.title === '@Garden site')
    return t?.meta.workflowTrigger === 'scheduled' ? t.meta.id : undefined
  }, 150_000)
  check('CROSS-02 it runs at the chosen minute, as a scheduled run', Boolean(ranId) && Date.now() >= target.getTime())
  await page.getByRole('tab', { name: /^Conversations/ }).click()
  await openConversation(page, '@Garden site')
  const approval = page.locator('.approval.open')
  await approval.waitFor({ timeout: 30_000 })
  check('CROSS-02 the run asks before starting its server', (await approval.textContent())?.includes('python3 -u -m http.server') === true)
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  type Proc = { id: string; name: string; status: string; url?: string; owner: { kind: string; threadId?: string; runId?: string } }
  const site = await until('the site', async () => (await get<Proc[]>(page, '/api/processes')).find((p) => p.name === 'garden-site' && p.status === 'running' && p.url))
  const scheduledRuns = ranId ? await runsOf(page, ranId) : []
  const allRuns = (await get<Summary[]>(page, '/api/threads')).filter((s) => s.meta.title === '@Garden site')
  const servers = (await get<Proc[]>(page, '/api/processes')).filter((p) => p.name === 'garden-site' && p.status === 'running')
  check('CROSS-02 one run, one server, owned by that run', allRuns.length === 1 && scheduledRuns.length === 1 && servers.length === 1
    && site?.owner.kind === 'conversation' && site.owner.threadId === ranId && site.owner.runId === scheduledRuns[0], JSON.stringify({ runs: allRuns.length, servers: servers.length, owner: site?.owner }))
  // The message keeps the workflow as it was when it ran (its snapshot), so a later edit cannot rewrite history.
  const sent = ranId ? JSON.stringify((await get<{ events: Ev[] }>(page, `/api/threads/${ranId}/events`)).events.find((e) => e.event.kind === 'user_text')?.event ?? {}) : ''
  check('CROSS-02 the run carries the saved instructions as they were', sent.includes(instructions), sent.slice(0, 160))
  await until('run idle', async () => !(await working(page)), 20_000)
  const runCard = await openCard(page)
  await runCard.getByLabel('Local preview URL').fill(site?.url ?? '')
  await runCard.getByRole('button', { name: 'Capture preview' }).click()
  check('CROSS-02 the preview is captured on that run\'s result, as evidence and not a pass', Boolean(await until('capture', () => runCard.getByText('Captured, not yet judged').isVisible())))
  const receipt = ranId && scheduledRuns[0] ? await result(page, ranId, scheduledRuns[0]) : undefined
  check('CROSS-02 the receipt is on the scheduled run: one capture, intact', receipt?.runId === scheduledRuns[0] && receipt?.previews.length === 1 && receipt.previews[0]!.integrity === 'ok', JSON.stringify(receipt?.previews))
  await shot(page, '02-scheduled-run-preview')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  // What the page showed when it stopped: a miss is read before it is rerun (gate 10-08 run 3).
  const page = app ? await app.firstWindow().catch(() => undefined) : undefined
  if (page) {
    await shot(page, 'failure').catch(() => undefined)
    const seen = await page.evaluate(() => ({
      status: [...document.querySelectorAll('.thread-status .status-text')].map((el) => el.textContent),
      title: document.querySelector('.thread-head h1')?.textContent,
    })).catch((e: unknown) => ({ error: String(e) }))
    const threads = await get<unknown>(page, '/api/threads').catch((e: unknown) => String(e))
    writeFileSync(join(PROOF_DIR, 'cross-flow-failure.json'), JSON.stringify({ seen, threads }, null, 2))
  }
} finally {
  await app?.close().catch(() => undefined)
}
finish('proof:cross-flow')
