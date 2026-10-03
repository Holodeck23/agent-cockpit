// Packaged gate for parity wave 3 (rich replies, find list, full-text search, peeks). Seeded
// conversations, no agent runs, no network: browser opens are recorded in main.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-3
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave3-proof-'))
const project = join(root, 'app')
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(join(project, 'web'))
writeFileSync(join(project, 'src', 'app.ts'), ['// app', 'export const a = 1', 'export const total = a + 1', 'export const b = 2', ''].join('\n'))
writeFileSync(join(project, 'web', 'main.tsx'), 'line one\nline two\n')
writeFileSync(join(project, 'README.md'), '# App\n\nSecond paragraph line.\n')
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', project, ...args], { env: ENV, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
git('add', '.')
git('commit', '-q', '-m', 'first')
git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
const sha = git('rev-parse', 'HEAD')
// The shortest prefix a reply would link: a hash needs a letter and a digit (markdown/commit-links.ts).
const short = [7, 8, 9, 10, 11, 12].map((n) => sha.slice(0, n)).find((h) => /[a-f]/.test(h) && /\d/.test(h)) ?? sha

const store = createThreadStore(join(root, 'state'))
createWorkflowStore(store.root).save({ projectPath: project, name: 'review', prompt: 'Review the diff for risky changes.' })
let clock = Date.parse('2026-10-04T09:00:00Z')
const seed = (title: string, events: NormalizedEvent[], completed = false): string => {
  const ts = new Date(clock).toISOString()
  const meta = store.create({ id: randomUUID(), title, projectPath: project, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed, createdAt: ts, updatedAt: ts })
  for (const event of events) store.append(meta.id, event, new Date((clock += 1000)).toISOString())
  return meta.id
}
const says = (text: string): NormalizedEvent => ({ kind: 'assistant_text', messageId: randomUUID(), text })
const done: NormalizedEvent = { kind: 'result', ok: true }

const reply = [
  '## Summary', '',
  'Fixed the total in `src/app.ts:3` and checked web/main.tsx:2 too. The notes are in [the readme](README.md#L3).', '',
  `Committed as \`${short}\`. An older one, \`abc1234\`, is not in this repo.`, '',
  '- **Bold** item', '- [ ] open task', '', '| file | lines |', '|---|---|', '| app.ts | 4 |', '',
  '```ts', 'const needle = "src/app.ts:3 stays code"', '```', '',
  'Links: [docs](https://example.com/docs) and [bad](javascript:alert(1)).', '',
  'A chart: ![pixel](https://tracker.example/p.png)', '',
  '<script>alert(1)</script>',
].join('\n')
seed('Rich reply', [{ kind: 'user_text', text: 'Fix the total' }, says(reply), done])
seed('Needles', [
  { kind: 'user_text', text: 'Where is the needle?' }, says('First needle here.'), done,
  { kind: 'user_text', text: 'And another?' }, says('A second needle, and a third needle in one message.'), done,
])
seed('Clips', [{ kind: 'user_text', text: '@file:src%2Fapp.ts @workflow:review Check this', workflows: [{ name: 'review', prompt: 'Review the diff for risky changes.' }] }, says('Checked.'), done])
seed('Old work', [{ kind: 'user_text', text: 'Rename the zebracorn helper' }, says('Renamed it.'), done], true)

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave3-${name}.png`) })
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const opened = () => app.evaluate(() => (globalThis as unknown as { proofOpened: string[] }).proofOpened)

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { proofOpened: string[] }
    g.proofOpened = []
    shell.openExternal = async (url: string) => { g.proofOpened.push(url) }
  })
  await openProject(page, project, 'App')
  const open = async (title: string) => {
    await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Conversations/ }).click()
    await page.locator('.card').filter({ hasText: title }).click()
    await page.getByRole('heading', { level: 1, name: title }).waitFor()
  }

  // G1: Markdown, safely.
  await open('Rich reply')
  const bubble = page.locator('.bubble.reply').first()
  check('G1 headings, lists, tables and code render', (await bubble.locator('h2').innerText()) === 'Summary'
    && (await bubble.locator('li strong').innerText()) === 'Bold' && (await bubble.locator('table td').count()) === 2 && (await bubble.locator('pre code').count()) === 1)
  check('G1 task lists show as read-only boxes', await bubble.locator('input[type=checkbox]').isDisabled())
  check('G1 raw HTML shows as text, never as elements', (await bubble.locator('script, img, iframe').count()) === 0 && (await bubble.innerText()).includes('<script>alert(1)</script>'))
  check('G1 an unsafe link is only its words', (await bubble.locator('a', { hasText: 'bad' }).count()) === 0 && (await bubble.getByText('bad').count()) > 0)
  check('G1 a remote image is never fetched; its alt text links out', (await bubble.locator('a.reply-image').getAttribute('href')) === 'https://tracker.example/p.png')
  await bubble.getByRole('link', { name: 'docs' }).click()
  check('G1 web links open in the browser', await until('docs opened', async () => (await opened()).includes('https://example.com/docs')))
  await shot(page, 'g1-reply-light')
  await setTheme(page, 'Dark')
  await shot(page, 'g1-reply-dark')
  await setTheme(page, 'Light')

  // G3: commit links.
  const commit = bubble.locator(`.commit-link[data-commit="${short}"]`)
  await commit.click()
  check('G3 a commit hash opens its page on the host', await until('commit page', async () => (await opened()).includes(`https://github.com/acme/app/commit/${sha}`)), (await opened()).join(' '))
  await bubble.locator('.commit-link[data-commit="abc1234"]').click()
  check('G3 a hash that is not a commit here says so', await until('note', async () => (await bubble.locator('.commit-note').innerText()).includes('Not a commit in this project')))

  // G2: path:line opens Files at that line.
  check('G2 code spans, prose and relative links become file links; code blocks do not', (await bubble.locator('.file-link[data-path]').count()) === 3
    && (await bubble.locator('pre .file-link').count()) === 0)
  const selection = () => page.getByRole('textbox', { name: 'File contents' }).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))
  await bubble.locator('.file-link[data-path="src/app.ts"]').click()
  check('G2 src/app.ts:3 opens Files with line 3 selected', await until('line 3', async () => (await selection()) === 'export const total = a + 1'), await selection().catch(() => ''))
  await shot(page, 'g2-files-line')
  await open('Rich reply')
  await page.locator('.bubble.reply .file-link[data-path="README.md"]').click()
  check('G2 a Markdown file opens in Source at the line', await until('readme line', async () => (await selection()) === 'Second paragraph line.')
    && (await page.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')) === 'true')

  // A3: the find list.
  await open('Needles')
  await page.locator('.thread-head h1').click()
  await page.keyboard.press('Meta+f')
  const findBox = page.getByRole('searchbox', { name: 'Find in conversation' })
  await findBox.fill('needle')
  const results = page.getByRole('list', { name: 'Matching messages' })
  check('A3 the matching messages are listed under the bar', await until('rows', async () => (await results.locator('li').count()) === 3), String(await results.locator('li').count()))
  check('A3 excerpts are the message text, without the author line', (await results.locator('.find-result-text').first().innerText()) === 'Where is the needle?', await results.locator('.find-result-text').first().innerText())
  check('A3 a message with several matches shows its count', (await results.locator('.find-result-count').allInnerTexts()).includes('2'))
  await results.locator('li').nth(2).getByRole('button').click()
  check('A3 a row jumps to its first match', (await page.locator('.find-count').innerText()) === '3 of 4', await page.locator('.find-count').innerText())
  await shot(page, 'a3-find-list')
  await findBox.press('Escape')
  await open('Rich reply')
  await page.locator('.thread-head h1').click()
  await page.keyboard.press('Meta+f')
  await findBox.fill('src/app.ts')
  check('A3 find also searches inside file links', await until('link match', async () => (await page.locator('.find-count').innerText()).endsWith('of 2')), await page.locator('.find-count').innerText())
  await findBox.press('Escape')

  // A8: peek into a sent message's clips.
  await open('Clips')
  const chip = page.locator('.message-clips [title="src/app.ts"]')
  await chip.hover()
  const peek = page.locator('.peek-panel')
  check('A8 hovering a file clip shows its first lines', await until('peek', async () => (await peek.locator('.peek-text').innerText()).includes('export const total = a + 1')))
  await shot(page, 'a8-peek')
  await peek.getByRole('button', { name: 'Open in Files' }).click()
  check('A8 Open in Files opens it', await until('files', async () => (await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { selected: true }).innerText()).startsWith('app.ts')))
  await open('Clips')
  await page.locator('.workflow-clip summary').hover()
  const flowPeek = page.locator('.peek', { has: page.locator('.workflow-clip') }).locator('.peek-panel')
  check('A8 hovering a workflow clip shows the instructions it sent', await until('workflow peek', async () => (await flowPeek.innerText()).includes('Review the diff for risky changes.')),
    `panels open: ${await page.locator('.peek-panel').count()}; texts: ${(await page.locator('.peek-panel').allInnerTexts()).join(' | ').slice(0, 200)}`)

  // A9: search every message, completed included while searching.
  await page.getByRole('checkbox', { name: 'Show completed' }).uncheck()
  check('A9 a completed conversation is hidden normally', (await page.locator('.card').filter({ hasText: 'Old work' }).count()) === 0)
  const search = page.getByRole('searchbox', { name: 'Search conversations' })
  await search.fill('zebracorn')
  const found = page.locator('.card').filter({ hasText: 'Old work' })
  check('A9 searching finds it by a word only in its messages', await until('found', async () => (await found.count()) === 1))
  check('A9 and shows where the word is', (await found.locator('.card-excerpt').innerText()).includes('zebracorn'))
  await shot(page, 'a9-search')
  await search.fill('')
  check('A9 clearing the search hides it again', await until('hidden', async () => (await found.count()) === 0))

  // The narrow list keeps every filter in view.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  const fits = await page.locator('.filters').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  check('the four filters fit the narrow list', fits)
  await open('Rich reply')
  await setTheme(page, 'Dark')
  await shot(page, 'narrow-dark')
} finally {
  await app.close()
}
finish('PROOF WAVE 3')
