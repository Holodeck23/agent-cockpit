// Checkpoint 3 gate (project instructions), PACKAGED app: `npm run proof:instructions`.
// Instructions are set through the project settings dialog and carry a codeword. Real agents
// (Claude Haiku, Codex; a few cents) must answer with it in project A, and must not know it in
// project B. An edit shows as a pending revision until the agent next starts.
import { randomInt } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, openProject, startConversation } from './lib/ui.ts'

const codexModel = process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna'
const { check, finish } = checker()
const words = ['amber', 'cobalt', 'juniper', 'saffron', 'tundra', 'willow', 'quartz', 'harbor']
const codeword = (): string => `plover-${words[randomInt(words.length)]}-${words[randomInt(words.length)]}`
const QUESTION = 'What is the project codeword? Reply with the codeword only, or "none" if you were not given one.'

const root = mkdtempSync(join(tmpdir(), 'cockpit-instructions-proof-'))
const projectA = join(root, 'alpha-site')
const projectB = join(root, 'beta-site')
for (const dir of [projectA, projectB]) {
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), '# Synthetic project\n')
}
mkdirSync(PROOF_DIR, { recursive: true })

interface Detail { status: string; events: { event: { kind: string; text?: string } }[] }
interface Summary { meta: { id: string; title: string; projectPath: string } }
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>

async function waitUntil<T>(page: Page, what: string, read: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(500)
  }
}

/** Asks in a new conversation and returns the finished reply. */
async function ask(page: Page, project: string, agent: 'claude' | 'codex'): Promise<string> {
  const before = new Set((await getJson<Summary[]>(page, '/api/threads')).map((t) => t.meta.id))
  await chooseAgent(page, agent === 'codex' ? { agent, model: codexModel, permissions: 'manual' } : { agent, model: 'haiku', permissions: 'manual' })
  await startConversation(page, QUESTION)
  const thread = await waitUntil(page, 'the conversation', async () =>
    (await getJson<Summary[]>(page, '/api/threads')).find((t) => !before.has(t.meta.id) && t.meta.projectPath === project))
  const detail = await waitUntil(page, `the ${agent} turn`, async () => {
    const d = await getJson<Detail>(page, `/api/threads/${thread.meta.id}/events`)
    return d.status === 'done' || d.status === 'error' ? d : undefined
  })
  return detail.events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '').join('\n').trim()
}

async function setInstructions(page: Page, projectName: string, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByRole('menuitem', { name: `${projectName} settings…` }).click()
  const dialog = page.getByRole('dialog', { name: projectName })
  await dialog.getByLabel('Project instructions').fill(text)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.getByText('saved').waitFor()
}

const app = await launchPackagedApp()
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, projectB, 'Beta site')
  await openProject(page, projectA, 'Alpha site')

  const first = codeword()
  await setInstructions(page, 'Alpha site', `The project codeword is ${first}. Only this project has a codeword.`)
  const dialog = page.getByRole('dialog', { name: 'Alpha site' })
  check('the dialog shows the saved revision', ((await dialog.locator('.modal-count').textContent()) ?? '').includes('revision 1'))
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-3-instructions.png') })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()

  const claudeAnswer = await ask(page, projectA, 'claude')
  check('Claude received the project instructions', claudeAnswer.includes(first), claudeAnswer.slice(0, 80))
  await page.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Conversation' })
  check('the conversation says which revision it started with', ((await menu.textContent()) ?? '').includes('Project instructions: revision 1'))
  await page.keyboard.press('Escape')

  const second = codeword()
  await setInstructions(page, 'Alpha site', `The project codeword is ${second}. Only this project has a codeword.`)
  await page.getByRole('dialog', { name: 'Alpha site' }).getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  const pending = ((await menu.textContent()) ?? '')
  check('an edit shows as pending until the agent next starts', pending.includes('revision 2 is saved') && pending.includes('this session has 1'), pending.slice(0, 160))
  await page.keyboard.press('Escape')

  const codexAnswer = await ask(page, projectA, 'codex')
  check('Codex received the current revision', codexAnswer.includes(second) && !codexAnswer.includes(first), codexAnswer.slice(0, 80))

  await page.getByRole('tab', { name: /Beta site/ }).click()
  const otherAnswer = await ask(page, projectB, 'codex')
  check('another project never gets them', !otherAnswer.includes('plover'), otherAnswer.slice(0, 80))
} finally {
  await app.close()
}
finish('INSTRUCTIONS')
