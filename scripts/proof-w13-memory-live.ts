// Bounded live packaged proof: pinned Claude calls Cockpit's scoped recall tool.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Page } from 'playwright-core'
import { APP_BUNDLE, launchPackagedApp } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const CLI = process.env.COCKPIT_W13_CLAUDE
assert.ok(CLI, 'Set COCKPIT_W13_CLAUDE to the pinned Claude CLI path')
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(sha(realpathSync(CLI)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
assert.match(execFileSync(CLI, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
assert.ok(process.env.COCKPIT_APP, 'Set COCKPIT_APP to the exact proof package')
assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1', 'Live proof must not take the Mac foreground')

type Event = { kind: string; name?: string; content?: string; text?: string; message?: string; ok?: boolean }
const events = (page: Page, id: string): Promise<Event[]> => page.evaluate(async (threadId) => {
  const body = await (await fetch(`/api/threads/${threadId}/events`)).json() as { data: { events: Array<{ event: Event }> } }
  return body.data.events.map(({ event }) => event)
}, id)

const root = mkdtempSync(join(tmpdir(), 'cockpit-w13-memory-live-'))
const state = join(root, 'state'), project = join(root, 'project')
mkdirSync(state, { mode: 0o700 }); mkdirSync(project)
const marker = `orchid-${randomUUID()}`
const now = new Date().toISOString()
writeFileSync(join(state, 'memory.json'), JSON.stringify([{ id: randomUUID(), scope: 'project', projectPath: project,
  text: `The synthetic release marker is ${marker}.`, source: { kind: 'you' }, createdAt: now, updatedAt: now }]), { mode: 0o600 })
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: dirname(CLI) })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'W13 memory proof')
  const toggles = await apiPost(page, '/api/projects', { path: project, claudeHooks: false, claudeMcp: false }) as
    { data?: { claudeHooks?: boolean; claudeMcp?: boolean } }
  assert.equal(toggles.data?.claudeHooks, false)
  assert.equal(toggles.data?.claudeMcp, false)
  const created = await apiPost(page, '/api/threads', { projectPath: project,
    text: 'Use the cockpit recall tool to look up the synthetic release marker, then reply with the marker exactly. Do not use files or a shell.',
    settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'inherit', mcpSetup: 'inherit' } }) as
    { data?: { id: string }; error?: string }
  assert.ok(created.data?.id, created.error ?? 'The memory proof thread was not created')
  const deadline = Date.now() + 120_000
  let seen: Event[] = []
  while (Date.now() < deadline) {
    seen = await events(page, created.data.id)
    if (seen.some((event) => event.kind === 'result')) break
    await page.waitForTimeout(500)
  }
  assert.equal(seen.find((event) => event.kind === 'result')?.ok, true,
    seen.filter((event) => event.kind === 'error').map((event) => event.message).join('; ') || 'No completed result')
  assert.ok(seen.some((event) => event.kind === 'tool_use' && event.name === 'mcp__cockpit__recall'), 'Claude did not call Cockpit recall')
  assert.ok(seen.some((event) => event.kind === 'tool_result' && event.content?.includes(marker)), 'Scoped recall did not return the project note')
  assert.ok(seen.some((event) => event.kind === 'assistant_text' && event.text?.includes(marker)), 'Claude did not use the recalled note')
  console.log(`W13 LIVE MEMORY PASS: pinned CLI, packaged app, authenticated scoped recall; package ${APP_BUNDLE}`)
} finally {
  await app.close()
}
