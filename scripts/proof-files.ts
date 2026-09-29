// Packaged-app file browser proof with synthetic files. No agent calls.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { ROOT, LAUNCHD_PATH, PROOF_DIR } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'
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
  await page.getByLabel('File contents').filter({ hasText: 'Hello from Cockpit' }).waitFor()
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
  console.log('FILES PASS')
} finally { await app.close() }
