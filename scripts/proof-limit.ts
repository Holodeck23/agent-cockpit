// P0 usage-limit gate, run against the PACKAGED app (npm run package first): `npm run proof:limit`.
// Claude is replaced by a recorded stand-in (scripts/fixtures/limit-agent) whose every turn hits the
// five-hour limit, so the check costs nothing and never depends on the real account being capped.
// The conversation must end visibly (Error, not Working), the menu must show the latest
// provider-reported status and reset time, and a manual switch to the real Codex must continue
// from the transcript: one short Codex turn (a few cents) recalls a codeword only Claude was told.
import { randomInt } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const codexModel = process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna'
const { check, finish } = checker()

interface UsageEvent { kind: 'usage'; status: string; resetsAt?: number }
interface StoredEvent { event: { kind: string; text?: string; status?: string; resetsAt?: number; to?: string } }
interface Detail { meta: { id: string; settings: { agent: string } }; status: string; events: StoredEvent[] }
interface Summary { meta: { id: string; title: string } }

const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>

/** Polls from Node: page.waitForFunction does not await an async predicate (a Promise is truthy). */
async function waitUntil<T>(page: Page, what: string, read: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(500)
  }
}

/** The menu line ThreadMenu renders for a usage event, computed in the page's own locale. */
async function expectedUsageLine(page: Page, usage: UsageEvent): Promise<string> {
  const labels: Record<string, string> = { allowed: 'Within your limit', allowed_warning: 'Getting close to your limit', rejected: 'Limit reached' }
  const time = usage.resetsAt
    ? await page.evaluate((s) => new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), usage.resetsAt)
    : undefined
  return `5-hour usage: ${labels[usage.status] ?? usage.status}${time ? `, resets ${time}` : ''}`
}

const lastUsage = (detail: Detail): UsageEvent | undefined =>
  [...detail.events].reverse().map((e) => e.event).find((e): e is UsageEvent => e.kind === 'usage')

async function menuUsageLine(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'More', exact: true }).click()
  const line = page.getByRole('menu', { name: 'Conversation' }).locator('.menu-note').filter({ hasText: '5-hour usage' })
  await line.waitFor()
  return ((await line.textContent()) ?? '').trim()
}

const state = mkdtempSync(join(tmpdir(), 'cockpit-limit-proof-'))
const project = join(state, 'limit-project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# Limit proof\n\nA synthetic project for the usage-limit acceptance check.\n')
mkdirSync(PROOF_DIR, { recursive: true })

const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/limit-agent') })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Limit proof')
  await chooseAgent(page, { agent: 'claude', model: 'haiku', permissions: 'manual' })
  // Words, not hex: a low-effort model once echoed "heron-3d2e0830" as "heron-3d2e083"
  // although its session log shows the full word arrived in the handoff.
  const words = ['amber', 'cobalt', 'juniper', 'saffron', 'tundra', 'willow', 'quartz', 'harbor']
  const pick = (): string => words[randomInt(words.length)] ?? 'amber'
  const codeword = `heron-${pick()}-${pick()}`
  const prompt = `Remember the codeword ${codeword}. Reply with OK.`
  await startConversation(page, prompt)
  const { meta } = await waitUntil(page, 'the conversation to appear', async () =>
    (await getJson<Summary[]>(page, '/api/threads')).find((t) => t.meta.title.startsWith('Remember the codeword')))
  const failed = await waitUntil(page, 'the limited turn to end', async () => {
    const detail = await getJson<Detail>(page, `/api/threads/${meta.id}/events`)
    return detail.status === 'working' || detail.status === 'needs_input' ? undefined : detail
  }, 30_000)
  check('a limit-rejected turn ends instead of staying Working', failed.status === 'error', `status ${failed.status}`)
  await headStatus(page).filter({ hasText: 'Error' }).waitFor()
  check('the header shows Error', true)
  await page.locator('.events').getByText('hit your session limit').first().waitFor()
  await page.locator('.note-error').filter({ hasText: 'Turn failed' }).waitFor()
  check('the limit message and a failed-turn note are visible in the conversation', true)

  const limitUsage = lastUsage(failed)
  check('the rejected five-hour usage event was stored', limitUsage?.status === 'rejected' && typeof limitUsage.resetsAt === 'number')
  const limitLine = await menuUsageLine(page)
  const wantLimit = limitUsage ? await expectedUsageLine(page, limitUsage) : '(no usage event)'
  check('the menu shows "Limit reached" with the reset time', limitLine === wantLimit, limitLine)
  await page.screenshot({ path: join(PROOF_DIR, 'p0-limit-reached.png') })
  await page.keyboard.press('Escape')

  // Manual switch: the stopped conversation goes to Codex with its transcript.
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByRole('radio', { name: 'Codex', exact: true }).click()
  await panel.getByLabel('Model').fill(codexModel)
  await panel.getByLabel('Effort').selectOption('low')
  await panel.getByRole('button', { name: 'Switch', exact: true }).click()
  const switched = await waitUntil(page, 'the switch to Codex', async () => {
    const detail = await getJson<Detail>(page, `/api/threads/${meta.id}/events`)
    return detail.meta.settings.agent === 'codex' ? detail : undefined
  }, 15_000)
  check('the conversation switched to Codex', switched.events.some((e) => e.event.kind === 'agent_switch' && e.event.to === 'codex'))

  await messageBox(page).fill('What codeword did I ask you to remember? Reply with the codeword only.')
  await messageBox(page).press('Enter')
  const answered = await waitUntil(page, 'the Codex turn to finish', async () => {
    const detail = await getJson<Detail>(page, `/api/threads/${meta.id}/events`)
    const after = detail.events.slice(detail.events.findIndex((e) => e.event.kind === 'agent_switch'))
    return after.some((e) => e.event.kind === 'result') && detail.status !== 'working' ? detail : undefined
  })
  const afterSwitch = answered.events.slice(answered.events.findIndex((e) => e.event.kind === 'agent_switch'))
  const said = afterSwitch.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '').join('\n')
  check('Codex finished the follow-up', answered.status === 'done', `status ${answered.status}`)
  check('Codex continued from the transcript (recalled the codeword)', said.includes(codeword), said.trim().slice(0, 80))

  const latest = lastUsage(answered)
  const latestLine = await menuUsageLine(page)
  const wantLatest = latest ? await expectedUsageLine(page, latest) : '(no usage event)'
  check('the menu follows the latest provider-reported usage', latestLine === wantLatest, latestLine)
  await page.screenshot({ path: join(PROOF_DIR, 'p0-limit-switched.png') })
} finally {
  await app.close()
}
finish('LIMIT')
