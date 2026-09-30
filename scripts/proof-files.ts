// Packaged-app file browser proof with synthetic files, plus one real agent turn (--codex selects Codex) that
// answers from an attached file (a few cents). The stored message, title and
// transcript must keep the reference, never the file's contents.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { ROOT, LAUNCHD_PATH, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, openProject } from './lib/ui.ts'
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
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const agent = process.argv.includes('--codex') ? 'codex' : 'claude'
const model = agent === 'codex' ? (process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna') : 'haiku'

const state = mkdtempSync(join(tmpdir(), 'cockpit-files-proof-'))
const project = join(state, 'sample-project'); mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'src', 'hello world.ts'), '// Greeting module\nexport const greeting = "Hello from Cockpit"\n')
writeFileSync(join(project, 'binary.bin'), Buffer.from([1, 0, 2]))
const app = await electron.launch({ executablePath: join(ROOT, 'release/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit'),
  env: { ...process.env, COCKPIT_HOME: state, PATH: LAUNCHD_PATH } })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Files proof')
  await page.getByRole('textbox', { name: 'Message' }).fill('Please inspect this file.')
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'binary.bin' }).click()
  await page.getByRole('alert').filter({ hasText: 'Binary files' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Add to conversation', exact: true }).count(), 0)
  console.log('PASS unsupported binary shows an error without an attach action')
  await page.locator('.file-row').filter({ hasText: 'src' }).click()
  await page.locator('.file-row').filter({ hasText: 'hello world.ts' }).click()
  await waitUntil(page, 'the file text', async () => (await page.getByLabel('File contents').inputValue()).includes('Hello from Cockpit'), 15_000)
  mkdirSync(PROOF_DIR, { recursive: true })
  await page.screenshot({ path: join(PROOF_DIR, 'phase-5-files.png') })
  await page.getByRole('button', { name: 'Add to conversation', exact: true }).click()
  const expected = 'Please inspect this file.\n@file:src%2Fhello%20world.ts '
  await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === value, expected)
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), expected)
  await page.reload()
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), expected)
  console.log('PASS encoded filename attached once, preserving draft through reload')
  // Simulate a removed file on submit; keep the draft and show the server error.
  await page.route('**/api/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'File no longer exists' }) })
  })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.locator('.composer [role="alert"]').filter({ hasText: 'File no longer exists' }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), expected)
  console.log('PASS failed attachment send retains the draft and shows a useful error')
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'src' }).click()
  await page.locator('.file-row').filter({ hasText: 'hello world.ts' }).click()
  await page.getByLabel('File contents').waitFor()
  await page.setViewportSize({ width: 980, height: 720 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-5-files-dark.png') })
  await page.getByRole('button', { name: '↑ Up', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'binary.bin' }).waitFor()
  console.log('PASS folder navigation and dark mode at minimum desktop width')
  const store = createThreadStore(state)
  const id = randomUUID(); const now = new Date().toISOString()
  store.create({ id, projectPath: project, title: 'Existing task', settings: threadSettingsSchema.parse({}),
    sessionId: randomUUID(), sessionStarted: false, completed: false, createdAt: now, updatedAt: now })
  store.append(id, { kind: 'user_text', text: 'Synthetic task' }); store.append(id, { kind: 'result', ok: true })
  await page.reload()
  await page.locator('.card').filter({ hasText: 'Existing task' }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill('Follow-up')
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'src' }).click()
  await page.locator('.file-row').filter({ hasText: 'hello world.ts' }).click()
  await page.getByRole('button', { name: 'Add to conversation', exact: true }).click()
  const followup = 'Follow-up\n@file:src%2Fhello%20world.ts '
  await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === value, followup)
  assert.equal(await page.locator('.thread h1').textContent(), 'Existing task')
  let sent = ''
  await page.route(`**/api/threads/${id}/messages`, async (route) => {
    sent = route.request().postDataJSON().text as string
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  const delivered = page.waitForResponse((res) => res.url().endsWith(`/threads/${id}/messages`))
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await delivered
  assert.equal(sent, followup.trim())
  console.log('PASS attachment preserves and targets the existing conversation draft')
  // One real agent turn: the answer must come from the attachment, the record must not hold it.
  await page.unrouteAll({ behavior: 'wait' })
  const codeword = `lantern-${randomUUID().slice(0, 8)}`
  mkdirSync(join(project, 'notes'))
  writeFileSync(join(project, 'notes', 'release.md'), `# Release notes\n\nThe release codename is ${codeword}.\n`)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: 'New conversation' }).click()
  await chooseAgent(page, { agent, model, permissions: 'manual' })
  const question = 'What is the release codename in the attached note? Reply with the codename only.'
  await page.getByRole('textbox', { name: 'Message' }).fill(question)
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await page.locator('.file-row').filter({ hasText: 'notes' }).click()
  await page.locator('.file-row').filter({ hasText: 'release.md' }).click()
  await page.getByRole('button', { name: 'Add to conversation', exact: true }).click()
  const typed = `${question}\n@file:notes%2Frelease.md`
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  type Summary = { meta: { id: string; title: string }; status: string; preview: string }
  const thread = await waitUntil(page, 'the agent turn to finish', async () => (await getJson<Summary[]>(page, '/api/threads'))
    .find((t) => t.meta.title.startsWith('What is the release codename') && (t.status === 'done' || t.status === 'error')))
  type Detail = { meta: { title: string }; events: { event: { kind: string; text?: string } }[]; transcriptPath: string }
  const detail = await getJson<Detail>(page, `/api/threads/${thread.meta.id}/events`)
  const said = detail.events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '').join('\n')
  const stored = detail.events.filter((e) => e.event.kind === 'user_text').map((e) => e.event.text)
  const tools = detail.events.filter((e) => e.event.kind === 'tool_use').length
  assert.equal(thread.status, 'done', `${agent} turn ended as ${thread.status}; inspect provider errors before retrying`)
  assert.ok(said.includes(codeword), `answer did not use the attachment: ${said.slice(0, 200)}`)
  assert.equal(tools, 0, 'agent used tools, so the answer may not have come from the attachment')
  console.log(`PASS ${agent} answered from the attached file without tools (${said.trim().slice(0, 60)})`)
  assert.deepEqual(stored, [typed])
  assert.ok(!detail.meta.title.includes(codeword), 'title holds file contents')
  const transcript = readFileSync(detail.transcriptPath, 'utf8')
  assert.ok(transcript.includes('Attached: notes/release.md'), 'transcript does not name the attachment')
  assert.equal(transcript.split(codeword).length - 1, said.split(codeword).length - 1, 'transcript holds file contents beyond the answer')
  const bubble = page.locator('.bubble.user').last()
  await bubble.locator('.attachments').filter({ hasText: 'Attached: notes/release.md' }).waitFor()
  assert.ok(!((await bubble.textContent()) ?? '').includes(codeword), 'user bubble shows file contents')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-5-files-attached.png') })
  console.log('PASS stored message, title, transcript and bubble keep the reference, not the contents')
  console.log('FILES PASS')
} finally { await app.close() }
