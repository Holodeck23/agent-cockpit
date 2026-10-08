// D15 approval safety, LIVE: the real Claude Code (Haiku) and Codex CLIs, PACKAGED app, Manual
// permissions. Each agent is asked to run `touch` on a folder outside the project and outside
// $TMPDIR (Codex's Manual sandbox writes to both without asking), so every step needs an approval and
// leaves a file only if it really ran:
//   A  Deny             → no file, the step reads "Not allowed", the turn ends.
//   B  Allow for this session (whatever label the agent offers) → the file exists.
//   C  the same command again → recorded: asked again or not (what "for this session" covers).
//   D  a sibling command (another file) → recorded likewise.
// Uses a little provider usage. Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:approvals-live [-- --claude|--codex]
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const only = process.argv.find((a) => a === '--claude' || a === '--codex')?.slice(2)
const agents = (['claude', 'codex'] as const).filter((a) => !only || a === only)
const MODEL = { claude: 'haiku', codex: process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna' } as const
const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const working = async (page: Page): Promise<boolean> => /Working|Starting/.test((await headStatus(page).textContent().catch(() => '')) ?? '')
// Codex in Manual (on-request) asks only when the model requests escalation; unprompted, a sandboxed
// write outside the workspace just fails with "Operation not permitted" (recorded 10-08, gpt-5.6-luna).
let ESCALATE = ''
const ask = (file: string): string => `Run this exact shell command and nothing else, then say in one line what happened: touch "${file}"${ESCALATE}`

/** Waits for the turn to end, answering every approval card with `answer` (or Allow once when it is a later card). Returns the cards seen. */
async function settle(page: Page, answer: (index: number, buttons: string[]) => string, ms = 240_000): Promise<Array<{ text: string; buttons: string[]; clicked: string }>> {
  const seen: Array<{ text: string; buttons: string[]; clicked: string }> = []
  const end = Date.now() + ms
  let idleSince = 0
  while (Date.now() < end) {
    const card = page.locator('.approval.open').first()
    if (await card.count()) {
      const buttons = await card.locator('.approval-actions button').allInnerTexts()
      const clicked = answer(seen.length, buttons)
      seen.push({ text: ((await card.innerText()) ?? '').slice(0, 400), buttons, clicked })
      await card.getByRole('button', { name: clicked, exact: true }).click()
      idleSince = 0
      await sleep(500)
      continue
    }
    if (await working(page)) idleSince = 0
    else if (!idleSince) idleSince = Date.now()
    else if (Date.now() - idleSince > 3_000) return seen
    await sleep(300)
  }
  console.log('  (timed out waiting for the turn to end)')
  return seen
}
const send = async (page: Page, text: string): Promise<void> => { await messageBox(page).fill(text); await messageBox(page).press('Enter'); await sleep(1_500) }
const lastReply = async (page: Page): Promise<string> => ((await page.locator('.bubble').last().innerText().catch(() => '')) ?? '').slice(0, 300)

const record: Record<string, unknown> = {}
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-d15-')))
// Outside folders are NOT under $TMPDIR: Codex's workspace-write sandbox lets it write there without asking.
const away = realpathSync(mkdtempSync(join(homedir(), 'Library/Caches/cockpit-d15-')))
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state') })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  for (const agent of agents) {
    const project = join(root, `${agent}-project`), out = join(away, `${agent}-outside`)
    mkdirSync(project); mkdirSync(out)
    writeFileSync(join(project, 'README.md'), '# scratch\n')
    await openProject(page, project, `${agent} d15`)
    await chooseAgent(page, { agent, model: MODEL[agent], permissions: 'manual' })
    ESCALATE = agent === 'codex' ? '. It writes outside the sandbox, so request escalated permissions for it.' : ''
    const allow = (buttons: string[]) => buttons.find((b) => b !== 'Allow' && b !== 'Deny') ?? 'Allow'
    const steps: Record<string, unknown> = {}

    // A: Deny.
    await startConversation(page, ask(join(out, 'denied.txt')))
    const a = await settle(page, () => 'Deny')
    const transcript = (await page.locator('.transcript').innerText()) ?? ''
    steps.A = { cards: a, reply: await lastReply(page), notAllowed: /Not allowed/.test(transcript) }
    check(`${agent} A: the command asks before it runs`, a.length >= 1, `${a.length} card(s)`)
    check(`${agent} A: Deny keeps it from running (no file)`, !existsSync(join(out, 'denied.txt')))
    check(`${agent} A: the refused step reads "Not allowed"`, /Not allowed/.test(transcript))
    await page.screenshot({ path: join(PROOF_DIR, `approvals-live-${agent}-A-deny.png`) })

    // B: Allow for this session.
    await send(page, ask(join(out, 'session-1.txt')))
    const b = await settle(page, (i, buttons) => (i === 0 ? allow(buttons) : 'Allow'))
    steps.B = { cards: b, reply: await lastReply(page) }
    check(`${agent} B: a session-wide choice is offered`, b.length >= 1 && b[0]!.buttons.length === 3, JSON.stringify(b[0]?.buttons))
    check(`${agent} B: allowing runs it (file exists)`, existsSync(join(out, 'session-1.txt')))

    // C: the same command again. D: a sibling command. Recorded as they are.
    await send(page, `${ask(join(out, 'session-1.txt'))} (yes, again)`)
    const c = await settle(page, () => 'Allow')
    await send(page, ask(join(out, 'session-2.txt')))
    const d = await settle(page, () => 'Allow')
    // E: the same kind of command in ANOTHER outside folder. F: another command in the same folder.
    // Both recorded: together with D they show how wide the session choice really is.
    const other = join(away, `${agent}-elsewhere`)
    mkdirSync(other)
    await send(page, ask(join(other, 'session-3.txt')))
    const e = await settle(page, () => 'Deny')
    await send(page, `Run this exact shell command and nothing else, then say in one line what happened: mkdir "${join(out, 'made-dir')}"${ESCALATE}`)
    const f = await settle(page, () => 'Deny')
    steps.C = { asked: c.length, cards: c, reply: await lastReply(page) }
    steps.D = { asked: d.length, cards: d, ran: existsSync(join(out, 'session-2.txt')) }
    const eRan = existsSync(join(other, 'session-3.txt')), fRan = existsSync(join(out, 'made-dir'))
    steps.E = { asked: e.length, ran: eRan }
    steps.F = { asked: f.length, ran: fRan }
    console.log(`  · ${agent} E (recorded): touch in another outside folder asked ${e.length} time(s), ran ${eRan}`)
    console.log(`  · ${agent} F (recorded): mkdir in the same folder asked ${f.length} time(s), ran ${fRan}`)
    check(`${agent} C: after "${b[0]?.clicked}", the same command does not ask again`, c.length === 0, `${c.length} card(s)`)
    console.log(`  · ${agent} D (recorded): a sibling command asked ${d.length} time(s)`)
    await page.screenshot({ path: join(PROOF_DIR, `approvals-live-${agent}-CD.png`) })
    record[agent] = steps
  }
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  writeFileSync(join(PROOF_DIR, 'approvals-live.json'), `${JSON.stringify(record, null, 2)}\n`)
  await app.close().catch(() => undefined)
  rmSync(away, { recursive: true, force: true })
}
finish('proof:approvals-live')
