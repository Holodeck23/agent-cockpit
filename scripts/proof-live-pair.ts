// D11, LIVE: one real Claude Code (Haiku) conversation and one real Codex conversation running at
// the same time in one project, PACKAGED app. Each is asked for a short note that starts and ends
// with its own code word. Followed without confusion means:
//   · both ran at once (a poll saw both Working),
//   · each conversation's reply holds its own code word and never the other's,
//   · the list shows both rows under their own agent, and opening each row shows its own reply.
// Uses a little provider usage. Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:live-pair
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, messageBox, openProject } from './lib/ui.ts'

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const salt = Math.random().toString(36).slice(2, 6).toUpperCase()
const WORD = { claude: `PAIRCLAUDE${salt}`, codex: `PAIRCODEX${salt}` } as const
const prompt = (word: string, topic: string): string =>
  `Do not run any commands or read any files. Write a note of about 120 words on ${topic}. Start the note with the code word ${word} and end it with ${word}.`

type Row = { meta: { id: string; settings: { agent: string } }; status: string }
const rows = (page: Page): Promise<Row[]> => page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Row[] }).data)
const replies = (page: Page, id: string): Promise<string> => page.evaluate(async (tid) => {
  const body = await (await fetch(`/api/threads/${tid}/events`)).json() as { data: { events: Array<{ event: { kind: string; text?: string } }> } }
  return body.data.events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '').join('\n')
}, id)

/** Opens a NEW conversation first, so the agent picker sets that conversation and leaves the running one alone. */
async function startWith(page: Page, choice: Parameters<typeof chooseAgent>[1], text: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await chooseAgent(page, choice)
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: text.slice(0, 20) }).waitFor({ timeout: 15_000 })
}

const root = mkdtempSync(join(tmpdir(), 'cockpit-live-pair-'))
const project = join(root, 'pair-project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# scratch\n')
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state') })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'Pair project')
  await startWith(page, { agent: 'claude', model: 'haiku', permissions: 'manual' }, prompt(WORD.claude, 'why small tools last'))
  await startWith(page, { agent: 'codex', model: process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna', permissions: 'manual' }, prompt(WORD.codex, 'how rivers shape cities'))

  let bothWorking = false
  const end = Date.now() + 240_000
  while (Date.now() < end) {
    const now = await rows(page)
    if (now.length === 2 && now.every((r) => r.status === 'working')) bothWorking = true
    if (now.length === 2 && now.every((r) => r.status !== 'working' && r.status !== 'starting')) break
    await sleep(300)
  }
  await page.screenshot({ path: join(PROOF_DIR, 'live-pair-list.png') })
  const all = await rows(page)
  const claude = all.find((r) => r.meta.settings.agent === 'claude')
  const codex = all.find((r) => r.meta.settings.agent === 'codex')
  check('two conversations exist, one per agent', all.length === 2 && Boolean(claude) && Boolean(codex), all.map((r) => r.meta.settings.agent).join(','))
  check('both were Working at the same time', bothWorking)
  if (claude && codex) {
    const [c, x] = await Promise.all([replies(page, claude.meta.id), replies(page, codex.meta.id)])
    check('Claude\'s reply carries its own code word and not Codex\'s', c.includes(WORD.claude) && !c.includes(WORD.codex), c.slice(0, 80))
    check('Codex\'s reply carries its own code word and not Claude\'s', x.includes(WORD.codex) && !x.includes(WORD.claude), x.slice(0, 80))
    check('both turns ended without an error', all.every((r) => r.status === 'idle' || r.status === 'done'), all.map((r) => r.status).join(','))
    // The list: open each row, read what the page shows.
    const cards = page.getByRole('navigation', { name: 'Conversations' }).locator('.cards button')
    check('the list shows both rows', (await cards.count()) === 2, String(await cards.count()))
    for (const [agentLabel, own, other] of [['Claude Code', WORD.claude, WORD.codex], ['Codex', WORD.codex, WORD.claude]] as const) {
      const row = cards.filter({ hasText: agentLabel }).first()
      await row.click()
      await page.getByRole('heading', { level: 1 }).waitFor()
      await sleep(600)
      const shown = (await page.locator('.transcript').innerText()) ?? ''
      check(`opening the ${agentLabel} row shows its own reply only`, shown.includes(own) && !shown.includes(other))
      await page.screenshot({ path: join(PROOF_DIR, `live-pair-${agentLabel.replace(' ', '-').toLowerCase()}.png`) })
    }
  }
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
}
finish('proof:live-pair')
