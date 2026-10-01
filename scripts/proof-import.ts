// Import conversations gate (U8, asked for after Mark Kashef's question), PACKAGED app: `npm run proof:import`.
// No agent usage. COCKPIT_IMPORT_HOME points the import at a fake home holding one Claude Code and one
// Codex session file in the CLIs' own shapes (scripts/lib/import-fixtures.ts), plus a Codex session from
// another folder. Stand-ins (scripts/fixtures/resume-agent) reply with the session they were resumed
// with, so continuing an imported conversation shows it is the same CLI session, for both agents.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { CLAUDE_SESSION, CODEX_SESSION, writeImportHome } from './lib/import-fixtures.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject } from './lib/ui.ts'

interface Meta { id: string; title: string; sessionId: string; sessionStarted: boolean; settings: { agent: string } }
const home = mkdtempSync(join(tmpdir(), 'cockpit-import-proof-'))
const project = join(home, 'garden-site')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# garden\n')
const fakeHome = join(home, 'fake-home')
writeImportHome(fakeHome, project, Date.now() - 2 * 3_600_000)
// Snapshot every source file, to show the import only reads them.
const sources = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => f.endsWith('.jsonl')).map((f) => [f, `${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f), 'utf8').length}`]))
const before = sources(fakeHome)
const threads = (page: Page): Promise<Meta[]> => page.evaluate(async () =>
  ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: Meta }> }).data.map((t) => t.meta))
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import conversations' })
async function openImport(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import conversations…' }).click()
  await dialog(page).locator('.import-row').first().waitFor()
}
async function reply(page: Page, text: string): Promise<string> {
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await page.waitForTimeout(500)
  return page.locator('.bubble.agent').last().innerText()
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(home, 'state'), COCKPIT_IMPORT_HOME: fakeHome, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/resume-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

try {
  await openProject(page, project, 'Garden site')
  await openImport(page)
  const rows = await dialog(page).locator('.import-row strong').allInnerTexts()
  check('the project\'s Claude Code and Codex sessions are listed, and nothing from other folders',
    rows.length === 2 && rows.includes('Now make it follow the system setting') === false
    && rows.includes('Add a dark mode toggle to the header') && rows.includes('Why is the build slow?'), rows.join(' | '))
  check('each row says which CLI, when and how long', /Claude Code · .* · 5 messages/.test(await dialog(page).locator('.import-row').filter({ hasText: 'dark mode' }).innerText())
    && /Codex · .* · 2 messages/.test(await dialog(page).locator('.import-row').filter({ hasText: 'build slow' }).innerText()))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-import.png') })

  // Claude Code: import, read, continue.
  await dialog(page).getByRole('button', { name: /^Import “Add a dark mode/ }).click()
  await dialog(page).waitFor({ state: 'detached' })
  await page.getByRole('heading', { level: 1, name: 'Add a dark mode toggle' }).waitFor()
  const claude = (await threads(page)).find((t) => t.settings.agent === 'claude')!
  check('importing opens a conversation that keeps the session id', claude.sessionId === CLAUDE_SESSION && claude.sessionStarted)
  const transcript = await page.locator('.transcript').innerText()
  check('it shows the messages and steps, not reasoning, side chains or command echoes',
    transcript.includes('Add a dark mode toggle to the header') && transcript.includes('Reading Header.tsx') && transcript.includes('Done: it follows the system')
    && !/secret reasoning|Side chain|command-name/.test(transcript))
  check('the next message resumes the same Claude Code session', (await reply(page, 'Thanks, one more tweak.')) === `Resumed Claude session ${CLAUDE_SESSION}.`)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-import-continued.png') })

  // Already imported: marked, and refused if asked again.
  await openImport(page)
  check('an imported session is marked In Cockpit', (await dialog(page).locator('.import-row').filter({ hasText: 'dark mode' }).innerText()).includes('In Cockpit'))
  const again = await apiPost(page, '/api/import', { projectPath: project, agent: 'claude', sessionId: CLAUDE_SESSION }) as { error?: string }
  check('importing it twice is refused', /already a conversation/.test(again.error ?? ''), again.error)

  // Codex: import, continue.
  await dialog(page).getByRole('button', { name: /^Import “Why is the build slow/ }).click()
  await page.getByRole('heading', { level: 1, name: 'Why is the build slow?' }).waitFor()
  const codex = (await threads(page)).find((t) => t.settings.agent === 'codex')!
  check('a Codex session imports with its thread id', codex.sessionId === CODEX_SESSION && codex.sessionStarted)
  check('its shell step and patch read as steps', await page.locator('.step-label').filter({ hasText: 'Running npm run build -- --profile' }).count() === 1)
  check('the next message resumes the same Codex thread', (await reply(page, 'Great, ship it.')) === `Resumed Codex thread ${CODEX_SESSION}.`)

  const outside = await apiPost(page, '/api/import', { projectPath: project, agent: 'codex', sessionId: 'other' }) as { error?: string }
  check('a session from another folder cannot be imported', /not in this project/.test(outside.error ?? ''), outside.error)
  check('the CLIs\' session files were only read', JSON.stringify(sources(fakeHome)) === JSON.stringify(before))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-import-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF IMPORT')
