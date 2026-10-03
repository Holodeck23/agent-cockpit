// Packaged UI + real Codex workflow gate. Uses synthetic project data and two short turns.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { ROOT, LAUNCHD_PATH, PROOF_DIR } from './lib/launch-app.ts'
import { openProject, chooseAgent } from './lib/ui.ts'

const state = mkdtempSync(join(tmpdir(), 'cockpit-workflow-proof-'))
const project = join(state, 'sample-project'); mkdirSync(project)
const app = await electron.launch({ executablePath: join(ROOT, 'release/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit'),
  env: { ...process.env, COCKPIT_HOME: state, PATH: LAUNCHD_PATH } })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Workflow proof')
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Create a workflow', exact: true }).click()
  await page.getByLabel('Reference name', { exact: true }).fill('quick-check')
  await page.getByLabel('Instructions', { exact: true }).fill('Reply only WORKFLOW_OK. Do not run commands or tools.')
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent settings' })
  // Agent selection uses the same controls as a conversation.
  await dialog.getByRole('radio', { name: 'Codex', exact: true }).click()
  await page.keyboard.press('Escape')
  await chooseAgent(page, { model: process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna', permissions: 'plan' })
  await page.getByRole('button', { name: 'Save workflow', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'quick-check' }).waitFor()
  const store = createWorkflowStore(state)
  let workflow = store.list(project)[0]!
  assert.equal(workflow.settings.agent, 'codex'); assert.equal(workflow.enabled, false)
  console.log('PASS workflow saved with selected agent and paused schedule')
  await page.getByRole('button', { name: 'Save and run', exact: true }).click()
  await page.locator('.thread h1').filter({ hasText: 'quick-check' }).waitFor()
  const waitForRun = async (id: string) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const detail = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data, id)
      if (detail.status === 'error') throw new Error(`Workflow failed: ${JSON.stringify(detail.events.slice(-3))}`)
      if (detail.status === 'done') {
        assert.ok(detail.events.some((e: { event: { kind: string; text?: string } }) => e.event.kind === 'assistant_text' && e.event.text?.includes('WORKFLOW_OK')))
        return
      }
      await page.waitForTimeout(500)
    }
    throw new Error('Workflow did not finish within 90 seconds')
  }
  workflow = store.list(project)[0]!
  await waitForRun(workflow.lastThreadId!)
  console.log('PASS manual workflow completes as a real Codex conversation')
  await page.getByRole('button', { name: 'Add context', exact: true }).click()
  await page.getByLabel('Search files and workflows').fill('quick')
  await page.getByRole('option').filter({ hasText: 'quick-check' }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), '@workflow:quick-check ')
  console.log('PASS composer inserts workflow reference')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.locator('.workflow-clip summary', { hasText: 'quick-check' }).first().waitFor({ timeout: 15_000 })
  const referenced = await page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { id: string }; status: string }> }).data)
  for (const t of referenced) await waitForRun(t.meta.id)
  console.log('PASS a message that uses a workflow keeps its instructions beside it')
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
  await page.locator('.workflow-row').filter({ hasText: 'quick-check' }).click()
  await page.getByLabel('Repeat', { exact: true }).selectOption('interval')
  await page.getByLabel('Every (minutes)', { exact: true }).fill('5')
  await page.getByRole('button', { name: 'Save and enable schedule', exact: true }).click()
  await page.getByRole('button', { name: 'Pause schedule', exact: true }).waitFor()
  workflow = store.list(project)[0]!
  assert.equal(workflow.enabled, true)
  // Advance the persisted due time, avoiding a five-minute test wait.
  store.update(workflow.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() })
  const previous = workflow.lastThreadId
  const deadline = Date.now() + 15_000
  while (store.get(workflow.id)?.lastThreadId === previous && Date.now() < deadline) await page.waitForTimeout(200)
  workflow = store.get(workflow.id)!
  assert.notEqual(workflow.lastThreadId, previous)
  await waitForRun(workflow.lastThreadId!)
  console.log('PASS due schedule creates and completes a fresh Codex conversation')
  await page.getByRole('button', { name: 'Pause schedule', exact: true }).click()
  await page.getByRole('button', { name: 'Pause schedule', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(store.get(workflow.id)?.enabled, false)
  mkdirSync(PROOF_DIR, { recursive: true })
  await page.screenshot({ path: join(PROOF_DIR, 'phase-5-workflows.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark' })
  await page.setViewportSize({ width: 980, height: 720 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-5-workflows-dark.png') })
  await page.getByRole('button', { name: 'Archive workflow', exact: true }).click()
  await page.locator('.workflow-row').waitFor({ state: 'hidden' })
  assert.equal(store.list(project).length, 0)
  console.log('PASS pause, minimum desktop width, dark mode, and archive')
  console.log('WORKFLOWS PASS')
} finally { await app.close() }
