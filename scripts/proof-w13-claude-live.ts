// W13 bounded live gate: pinned Claude CLI, packaged app, isolated project, no user hooks/connectors.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Page } from 'playwright-core'
import { APP_BUNDLE, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const CLI = process.env.COCKPIT_W13_CLAUDE
assert.ok(CLI, 'Set COCKPIT_W13_CLAUDE to the pinned Claude CLI path')
const CLI_SHA256 = '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081'
const NODE_SHA256 = '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b'
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(hash(realpathSync(CLI)), CLI_SHA256, 'Claude CLI changed since the W13 pin')
assert.match(execFileSync(CLI, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(hash(process.execPath), NODE_SHA256, 'Node runtime changed since the W13 pin')
assert.ok(process.env.COCKPIT_APP, 'Set COCKPIT_APP to the exact proof package')

type Event = { kind: string; text?: string; message?: string; ok?: boolean; sessionId?: string }
const events = (page: Page, id: string): Promise<Event[]> => page.evaluate(async (threadId) => {
  const body = await (await fetch(`/api/threads/${threadId}/events`)).json() as { data: { events: Array<{ event: Event }> } }
  return body.data.events.map(({ event }) => event)
}, id)
async function waitForResult(page: Page, id: string, count: number): Promise<Event[]> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const current = await events(page, id)
    if (current.filter((event) => event.kind === 'result').length >= count) return current
    await page.waitForTimeout(500)
  }
  throw new Error(`Claude did not finish turn ${count} within 120 seconds`)
}

const root = mkdtempSync(join(tmpdir(), 'cockpit-w13-live-'))
const project = join(root, 'project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# W13 live proof project\n')
mkdirSync(PROOF_DIR, { recursive: true })
const appEnv = { COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: dirname(CLI) }
let app = await launchPackagedApp(appEnv)
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'W13 live proof')
  const toggles = await apiPost(page, '/api/projects', { path: project, claudeHooks: false, claudeMcp: false }) as { data?: { claudeHooks?: boolean; claudeMcp?: boolean } }
  assert.equal(toggles.data?.claudeHooks, false)
  assert.equal(toggles.data?.claudeMcp, false)
  const first = await apiPost(page, '/api/threads', { projectPath: project, text: 'Do not use tools. Reply exactly W13LIVEONE.',
    settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'inherit', mcpSetup: 'inherit' } }) as { data?: { id: string }; error?: string }
  assert.ok(first.data?.id, first.error ?? 'The first thread was not created')
  const id = first.data.id
  const one = await waitForResult(page, id, 1)
  assert.equal(one.find((event) => event.kind === 'result')?.ok, true, one.filter((event) => event.kind === 'error').map((event) => event.message).join('; '))
  assert.ok(one.some((event) => event.kind === 'session' && event.sessionId), 'No real Claude session was established')
  assert.ok(one.some((event) => event.kind === 'assistant_text' && event.text?.includes('W13LIVEONE')), 'First reply missing')
  const next = await apiPost(page, `/api/threads/${id}/messages`, { text: 'Do not use tools. Reply exactly W13LIVETWO.' }) as { data?: unknown; error?: string }
  assert.ok(next.data, next.error ?? 'The later message was not accepted')
  const two = await waitForResult(page, id, 2)
  assert.equal(two.filter((event) => event.kind === 'result').at(-1)?.ok, true, two.filter((event) => event.kind === 'error').map((event) => event.message).join('; '))
  assert.ok(two.some((event) => event.kind === 'assistant_text' && event.text?.includes('W13LIVETWO')), 'Later reply missing')
  await app.close()
  app = await launchPackagedApp(appEnv)
  const resumedPage = await app.firstWindow()
  resumedPage.setDefaultTimeout(20_000)
  await resumedPage.waitForLoadState('domcontentloaded')
  const resumed = await apiPost(resumedPage, `/api/threads/${id}/messages`, { text: 'Do not use tools. Reply exactly W13LIVETHREE.' }) as { data?: unknown; error?: string }
  assert.ok(resumed.data, resumed.error ?? 'The resumed message was not accepted')
  const three = await waitForResult(resumedPage, id, 3)
  assert.equal(three.filter((event) => event.kind === 'result').at(-1)?.ok, true, three.filter((event) => event.kind === 'error').map((event) => event.message).join('; '))
  assert.ok(three.some((event) => event.kind === 'assistant_text' && event.text?.includes('W13LIVETHREE')), 'Resumed reply missing')
  await resumedPage.locator('.card').filter({ hasText: 'W13LIVEONE' }).click()
  await resumedPage.getByText('W13LIVETHREE', { exact: false }).first().waitFor()
  await resumedPage.screenshot({ path: join(PROOF_DIR, 'w13-live-claude.png') })
  console.log(`W13 LIVE CLAUDE PASS: first, later and resumed turns; CLI ${CLI_SHA256}; package ${APP_BUNDLE}`)
} finally {
  await app.close()
}
