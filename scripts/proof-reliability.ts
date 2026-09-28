// Deterministic desktop regression gate. Uses synthetic threads and no agent calls.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { ROOT, LAUNCHD_PATH } from './lib/launch-app.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-reliability-'))
const store = createThreadStore(stateRoot)
const ids = [randomUUID(), randomUUID()]
for (const [index, id] of ids.entries()) {
  const now = new Date().toISOString()
  store.create({ id, title: `Regression ${index === 0 ? 'Alpha' : 'Beta'}`, projectPath: stateRoot,
    settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false,
    completed: false, createdAt: now, updatedAt: now })
  store.append(id, { kind: 'user_text', text: `Synthetic conversation ${index}` })
  store.append(id, { kind: 'result', ok: true })
}
const app = await electron.launch({
  executablePath: join(ROOT, 'release/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit'),
  env: { ...process.env, COCKPIT_HOME: stateRoot, PATH: LAUNCHD_PATH },
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  const alpha = page.locator('.card').filter({ hasText: 'Regression Alpha' })
  const beta = page.locator('.card').filter({ hasText: 'Regression Beta' })
  await alpha.waitFor()
  let release!: () => void
  let intercepted!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const arrived = new Promise<void>((resolve) => { intercepted = resolve })
  await page.route(`**/api/threads/${ids[0]}/events`, async (route) => {
    const response = await route.fetch()
    intercepted()
    await held
    await route.fulfill({ response })
  })
  await alpha.click()
  await arrived
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).count(), 0, 'No stale composer while loading')
  await beta.click()
  await page.locator('.thread h1').filter({ hasText: 'Regression Beta' }).waitFor()
  const oldResponse = page.waitForResponse((res) => res.url().endsWith(`/threads/${ids[0]}/events`))
  release()
  await oldResponse
  // Let fetch callbacks and React commits settle after the deliberately late response.
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.thread h1').textContent(), 'Regression Beta')
  assert.equal(await beta.getAttribute('aria-current'), 'true')
  console.log('PASS delayed Alpha response cannot replace selected Beta')
  await beta.click()
  assert.equal(await page.locator('.thread h1').textContent(), 'Regression Beta')
  console.log('PASS selecting the same conversation keeps its detail')

  let sentTo = ''
  await page.route('**/api/threads/*/messages', async (route) => {
    sentTo = route.request().url()
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  await page.getByRole('textbox', { name: 'Message' }).fill('Synthetic follow-up')
  const sent = page.waitForResponse((res) => res.url().endsWith('/messages'))
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await sent
  assert.ok(sentTo.endsWith(`/threads/${ids[1]}/messages`))
  console.log('PASS follow-up targets Beta after out-of-order loads')

  await page.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor()
  assert.equal(store.get(ids[1]!)?.completed, true)
  await page.getByRole('checkbox', { name: 'Show completed' }).uncheck()
  await beta.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Reopen', exact: true }).click()
  await beta.waitFor()
  await page.getByRole('button', { name: 'Mark complete', exact: true }).waitFor()
  assert.equal(store.get(ids[1]!)?.completed, false)
  console.log('PASS completion, list filtering, and reopening update without reload')

  // A pending load must not replace the new-conversation view after deselection.
  await page.unroute(`**/api/threads/${ids[0]}/events`)
  let releaseAgain!: () => void
  let arrivedAgain!: () => void
  const holdAgain = new Promise<void>((resolve) => { releaseAgain = resolve })
  const requestedAgain = new Promise<void>((resolve) => { arrivedAgain = resolve })
  await page.route(`**/api/threads/${ids[0]}/events`, async (route) => {
    const response = await route.fetch()
    arrivedAgain()
    await holdAgain
    await route.fulfill({ response })
  })
  await alpha.click()
  await requestedAgain
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  const deselectedResponse = page.waitForResponse((res) => res.url().endsWith(`/threads/${ids[0]}/events`))
  releaseAgain()
  await deselectedResponse
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.thread h1').textContent(), 'New conversation')
  console.log('PASS late response cannot restore a deselected conversation')
  console.log('RELIABILITY PASS — synthetic data, no agent usage')
} finally {
  await app.close()
}
