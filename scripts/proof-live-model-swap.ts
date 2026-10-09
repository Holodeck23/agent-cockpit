// Mid-conversation model swap, LIVE: real Claude Code, PACKAGED app.
//   1  turn one on Haiku: the CLI reports Haiku and the conversation learns a code word.
//   2  swap the model in the open conversation (Agent settings, no new conversation).
//   3  turn two: the CLI reports the NEW model, the same session continues (the code word is still
//      known), and the conversation records the change.
// Uses a little provider usage. Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:live-model-swap
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const WORD = `SWAP${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const working = async (page: Page): Promise<boolean> => /Working|Starting/.test((await headStatus(page).textContent().catch(() => '')) ?? '')
async function settle(page: Page, ms = 180_000): Promise<void> {
  const end = Date.now() + ms
  let idleSince = 0
  while (Date.now() < end) {
    if (await working(page)) idleSince = 0
    else if (!idleSince) idleSince = Date.now()
    else if (Date.now() - idleSince > 3_000) return
    await sleep(300)
  }
}
type Ev = { kind: string; model?: string; text?: string }
const events = (page: Page, id: string): Promise<Ev[]> => page.evaluate(async (tid) => {
  const body = await (await fetch(`/api/threads/${tid}/events`)).json() as { data: { events: Array<{ event: Ev }> } }
  return body.data.events.map((e) => e.event)
}, id)

const root = mkdtempSync(join(tmpdir(), 'cockpit-model-swap-'))
const project = join(root, 'swap-project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# scratch\n')
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state') })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'Swap project')
  await chooseAgent(page, { agent: 'claude', model: 'haiku', permissions: 'manual' })
  await startConversation(page, `Do not run any commands. Remember the code word ${WORD}. Reply with one short line.`)
  await settle(page)
  const id = (await page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { id: string } }> }).data[0]!.meta.id))
  const first = await events(page, id)
  const firstModel = first.filter((e) => e.kind === 'session').at(-1)?.model ?? ''
  check('turn one ran on Haiku', /haiku/i.test(firstModel), firstModel)

  // In an open conversation the picker changes it only on Apply (a new conversation takes the choice at once).
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByLabel('Model').fill('sonnet')
  await panel.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(PROOF_DIR, 'model-swap-after-change.png') })
  await messageBox(page).fill('What was the code word? Reply with only the code word.')
  await messageBox(page).press('Enter')
  await sleep(1_500)
  await settle(page)
  const all = await events(page, id)
  const sessions = all.filter((e) => e.kind === 'session')
  const lastModel = sessions.at(-1)?.model ?? ''
  const reply = all.filter((e) => e.kind === 'assistant_text').at(-1)?.text ?? ''
  check('the change is recorded in the conversation', all.some((e) => e.kind === 'settings_changed' && /sonnet/i.test(e.model ?? '')), JSON.stringify(all.filter((e) => e.kind === 'settings_changed')))
  check('turn two ran on the new model (Sonnet)', /sonnet/i.test(lastModel), lastModel)
  check('the same conversation carried on: the code word is still known', reply.includes(WORD), reply.slice(0, 80))
  await page.screenshot({ path: join(PROOF_DIR, 'model-swap-turn-two.png') })
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
}
finish('proof:live-model-swap')
