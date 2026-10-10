// EA route Day 20 (main view), PACKAGED app, seeded conversations, no agent runs: among several
// conversations from different agents, find the one that fixed the login redirect and read what
// its agent said last. A person would scan the list, search, open the right one and read the end.
// This is the agent-run version of that task; it does not stand in for a person doing it.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:find-inspect
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-find-proof-'))
const project = join(root, 'shop')
mkdirSync(project)
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })

let clock = Date.parse('2026-10-10T08:00:00Z')
const says = (text: string): NormalizedEvent => ({ kind: 'assistant_text', messageId: randomUUID(), text })
const seed = (title: string, agent: 'claude' | 'codex' | 'antigravity', events: NormalizedEvent[], completed = false): void => {
  const ts = new Date(clock).toISOString()
  const meta = store.create({ id: randomUUID(), title, projectPath: project, settings: threadSettingsSchema.parse({ agent }), sessionId: randomUUID(), sessionStarted: false, completed, createdAt: ts, updatedAt: ts })
  for (const event of events) store.append(meta.id, event, new Date((clock += 60_000)).toISOString())
}
const done: NormalizedEvent = { kind: 'result', ok: true }
const LAST = 'Redirect fixed: after signing in you land on /dashboard again, and the test for it passes.'

seed('Checkout totals', 'claude', [{ kind: 'user_text', text: 'Why are checkout totals off by one cent?' }, says('Rounding happened per line; it now rounds once at the end.'), done])
seed('Auth follow-ups', 'codex', [
  { kind: 'user_text', text: 'After login users end up on the home page. Fix the redirect.' },
  says('Looking at the sign-in handler first.'),
  says(LAST), done,
])
seed('Login page copy', 'antigravity', [{ kind: 'user_text', text: 'Rewrite the login page copy so it sounds friendlier.' }, says('Here are three versions of the login copy.'), done])
seed('Image sizes', 'claude', [{ kind: 'user_text', text: 'Shrink the product images.' }, says('Converted them to WebP at two sizes.'), done])
seed('Old redirect notes', 'claude', [{ kind: 'user_text', text: 'Note the old redirect rules.' }, says('Written to docs/redirects.md.'), done], true)
seed('Search speed', 'codex', [{ kind: 'user_text', text: 'Search feels slow.' }, says('Added an index on products.name; search is now under 50 ms.'), done])

const app = await launchPackagedApp({ COCKPIT_HOME: store.root })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Shop')
  const cards = page.locator('.card')
  await cards.first().waitFor()
  await page.screenshot({ path: join(PROOF_DIR, 'find-1-list.png') })
  // Default rows (Appearance): title, agent and day, no message preview; Show completed is on.
  check('the list shows all six conversations, newest first', (await cards.count()) === 6 && ((await cards.first().innerText()).includes('Search speed')), `${await cards.count()} cards`)
  const target = cards.filter({ hasText: 'Auth follow-ups' })
  check('each row says which agent it is', (await target.locator('.card-meta').innerText()).includes('Codex')
    && (await cards.filter({ hasText: 'Login page copy' }).locator('.card-meta').innerText()).includes('Antigravity'))

  const search = page.getByRole('searchbox', { name: 'Search conversations' })
  await search.fill('login')
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, undefined, { timeout: 10_000 }).catch(() => undefined)
  check('searching "login" narrows to the two conversations that mention it', (await cards.count()) === 2
    && (await cards.filter({ hasText: 'Auth follow-ups' }).count()) === 1 && (await cards.filter({ hasText: 'Login page copy' }).count()) === 1, `${await cards.count()} cards`)
  check('each match shows where the word is, so the right one can be told apart', (await target.locator('.card-excerpt').innerText()).toLowerCase().includes('login'),
    await target.locator('.card-excerpt').innerText())
  await page.screenshot({ path: join(PROOF_DIR, 'find-2-search.png') })
  await search.fill('redirect')
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, undefined, { timeout: 10_000 }).catch(() => undefined)
  check('searching "redirect" also finds the completed note, marked as completed', (await cards.filter({ hasText: 'Old redirect notes' }).count()) === 1
    && (await cards.filter({ hasText: 'Old redirect notes' }).getAttribute('class'))?.includes('completed') === true)

  await cards.filter({ hasText: 'Auth follow-ups' }).click()
  await page.getByRole('heading', { level: 1, name: 'Auth follow-ups' }).waitFor()
  const last = page.locator('.bubble.reply').last()
  await last.waitFor()
  check('opening it shows the agent’s latest reply last', (await last.innerText()).includes('Redirect fixed'))
  const box = await last.boundingBox()
  const height = await page.evaluate(() => window.innerHeight)
  check('and that reply is on screen without scrolling', box !== null && box.y >= 0 && box.y + Math.min(box.height, 40) <= height, JSON.stringify(box))
  await page.screenshot({ path: join(PROOF_DIR, 'find-3-open.png') })
  await search.fill('')
  check('clearing the search keeps the opened conversation selected', (await cards.filter({ hasText: 'Auth follow-ups' }).getAttribute('aria-current')) === 'true')
} catch (error) {
  check(`unexpected: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, false)
} finally {
  await app.close()
}
finish('proof:find-inspect')
