// U4 calendar-schedule gate, run against the PACKAGED app (npm run package first): `npm run proof:schedules`.
// Claude is replaced by a stand-in that just answers (scripts/fixtures/echo-agent), so it costs nothing.
// A workflow set to run on today's weekday a minute or two from now must show its rule and the Mac's
// timezone, store the exact next run, actually run at that minute, move on to the same time next week,
// pause when edited, and come back as Daily / Every N min with the right labels after a reload.
// Clock-change and missed-run behaviour are covered by tests/calendar.test.ts and tests/workflows.test.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

interface Flow { id: string; name: string; enabled: boolean; nextRunAt: string | null; intervalMinutes: number | null; calendar: { days: number[]; time: string; timeZone: string } | null }
interface Summary { meta: { title: string; workflowTrigger?: string } }

const project = mkdtempSync(join(tmpdir(), 'cockpit-schedule-proof-'))
writeFileSync(join(project, 'README.md'), '# schedule proof\n')
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const flow = async (page: Page): Promise<Flow> => (await getJson<Flow[]>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`))[0]!
async function until<T>(page: Page, what: string, read: () => Promise<T | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(1000)
  }
}
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/echo-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
// The next whole minute at least 60 s away: the scheduler checks every 5 s.
const target = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000)
const day = target.getDay()

try {
  await openProject(page, project, 'Schedule demo')
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Create a workflow', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('Calendar check')
  await page.getByLabel('Reference name', { exact: true }).fill('calendar-check')
  await page.getByLabel('Instructions', { exact: true }).fill('Say done.')
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly')
  const days = page.getByRole('group', { name: 'Days' })
  await days.getByRole('button', { name: DAY[day], exact: true }).click()
  if (day !== 1) await days.getByRole('button', { name: 'Mon', exact: true }).click()
  await page.getByLabel('At', { exact: true }).fill(hhmm(target))
  check('the timezone is stated', await page.getByText(`Times are in ${zone}.`).isVisible(), zone)
  await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).click()
  await page.getByText(new RegExp(`^Scheduled · ${DAY[day]} at ${hhmm(target)} · Next run`)).waitFor()
  check('the editor shows the rule and next run', true)
  check('the list shows the rule', await page.locator('.workflow-row').filter({ hasText: `${DAY[day]} at ${hhmm(target)}` }).isVisible())
  const saved = await flow(page)
  check('stores days, time and zone, and the exact next run', saved.enabled && saved.intervalMinutes === null
    && JSON.stringify(saved.calendar) === JSON.stringify({ days: [day], time: hhmm(target), timeZone: zone })
    && saved.nextRunAt === target.toISOString(), `${saved.nextRunAt} vs ${target.toISOString()}`)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-schedules.png') })

  const ran = await until(page, 'the scheduled run', async () => (await getJson<Summary[]>(page, '/api/threads'))
    .find((t) => t.meta.title === 'Calendar check · Scheduled'), 150_000)
  const ranAt = Date.now()
  check('it ran at the chosen minute', ranAt >= target.getTime() && ranAt < target.getTime() + 20_000 && ran.meta.workflowTrigger === 'scheduled',
    `${Math.round((ranAt - target.getTime()) / 1000)} s after`)
  const after = await until(page, 'the next run to move on', async () => { const f = await flow(page); return f.nextRunAt !== target.toISOString() && f }, 15_000)
  const nextWeek = new Date(target); nextWeek.setDate(nextWeek.getDate() + 7)
  check('next run is the same local time a week later', after.nextRunAt === nextWeek.toISOString(), after.nextRunAt ?? '')

  // The filled textarea's own text joins its label's name, so match the start.
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Say done, briefly.')
  await page.getByRole('button', { name: 'Save workflow', exact: true }).click()
  await until(page, 'the pause', async () => !(await flow(page)).enabled, 10_000)
  check('editing pauses the schedule', await page.locator('.workflow-row').filter({ hasText: 'Manual / paused' }).isVisible())

  await page.getByLabel('Repeat', { exact: true }).selectOption('daily')
  await page.getByLabel('At', { exact: true }).fill('07:30')
  await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'Daily at 07:30' }).waitFor()
  const daily = await flow(page)
  const next = new Date(daily.nextRunAt!)
  check('Daily stores all seven days and runs next at 07:30 local', JSON.stringify(daily.calendar?.days) === '[0,1,2,3,4,5,6]'
    && hhmm(next) === '07:30' && next.getTime() > Date.now() && next.getTime() - Date.now() <= 24 * 3_600_000, daily.nextRunAt ?? '')

  await page.reload()
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'Calendar check' }).click()
  check('after a reload the editor shows Daily at 07:30', await page.getByLabel('Repeat', { exact: true }).inputValue() === 'daily'
    && await page.getByLabel('At', { exact: true }).inputValue() === '07:30')

  await page.getByLabel('Repeat', { exact: true }).selectOption('interval')
  await page.getByLabel('Every (minutes)', { exact: true }).fill('60')
  await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'Every 60 min' }).waitFor()
  const interval = await flow(page)
  check('minute intervals still work and clear the calendar', interval.intervalMinutes === 60 && interval.calendar === null && interval.enabled)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-schedules-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF SCHEDULES')
