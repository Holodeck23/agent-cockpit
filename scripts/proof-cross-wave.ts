// Packaged cross-wave checks for the wave 6.5 checkpoint (R9): features from different waves used
// together on one conversation, then across a restart. Stand-ins as in proof:wave-6.5
// (scripts/fixtures/wave65-agent), no provider usage. The phone half (questions and images over the
// Tailscale listener) is not here: it needs Tailscale running, and is recorded as run or not run.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:cross-wave
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { createThreadStore } from '../server/threads/store.ts'
import { documentsDir } from '../server/files/documents.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject, startConversation, switchWithHandoff } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-cross-wave-proof-'))
const project = join(root, 'app')
mkdirSync(project)
const store = createThreadStore(join(root, 'state'))
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png')).toString('base64')
writeFileSync(join(documentsDir(store.root, project), 'release-plan.md'), '# Release plan\n')
const newDocs = mkdtempSync(join(tmpdir(), 'cockpit-cross-wave-docs-'))
const env = { COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') }

async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `cross-${name}.png`) })
const send = async (page: Page, text: string): Promise<void> => { await messageBox(page).fill(text); await messageBox(page).press('Enter') }
const headText = async (page: Page): Promise<string> => (await headStatus(page).textContent().catch(() => '')) ?? ''
const settled = async (page: Page): Promise<boolean> => !/^(Starting|Working)/.test(await headText(page))
const getJson = <T>(page: Page, path: string): Promise<T> => page.evaluate(async (p) => (await (await fetch(p)).json()) as unknown, path) as Promise<T>
const imagesShown = (page: Page): Promise<boolean> => page.locator('.transcript img').evaluateAll((imgs) =>
  imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
type Detail = { data: { meta: { id: string; title: string }; events: { event: { kind: string; file?: string; from?: string } }[] } }

let app: ElectronApplication | undefined
try {
  app = await launchPackagedApp(env)
  let page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'App')

  // 1. Questions (wave 5) + an image you keep (wave 6) + a message that waits and runs (wave 5 J1),
  //    then an agent switch (wave 5 J5, repaired in R1): the handoff carries all of it.
  await startConversation(page, 'ask cross-wave')
  const card = page.locator('.question-card').last()
  await until('question card', async () => (await card.locator('.question').count()) === 2)
  await card.getByRole('radio', { name: /^Blue/ }).check()
  await card.getByRole('button', { name: 'Send answers' }).click()
  await until('answered', async () => (await page.locator('.bubble').filter({ hasText: /^Noted:/ }).count()) === 1)
  const threads = await getJson<{ data: { meta: { id: string; title: string } }[] }>(page, '/api/threads')
  const id = threads.data.find((t) => t.meta.title.startsWith('ask cross-wave'))!.meta.id
  await until('settled', () => settled(page))
  await apiPost(page, `/api/threads/${id}/messages`, { text: 'here is the logo', images: [{ data: ICON, name: 'logo.png' }] })
  check('1 the image you sent shows in the conversation', await until('image', () => imagesShown(page)))
  await until('settled', () => settled(page))
  await send(page, 'worklag')
  await until('working', async () => (await headText(page)).startsWith('Working'))
  await send(page, 'queued after the work')
  check('1 a message sent mid-turn waits', await until('waiting', async () => (await page.locator('.message.waiting').count()) === 1))
  check('1 and runs after the turn', await until('ran', async () => (await page.locator('.bubble').filter({ hasText: 'Got: queued after the work' }).count()) === 1, 15_000))
  await until('settled', () => settled(page), 10_000)
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const picker = page.getByRole('dialog', { name: 'Agent settings' })
  await picker.getByRole('radio', { name: 'Codex', exact: true }).click()
  await switchWithHandoff(picker)
  await send(page, 'What was chosen?')
  const handoff = page.locator('.bubble').filter({ hasText: /^Handoff: / })
  check('1 Codex answers after the switch', await until('codex', async () => (await handoff.count()) === 1))
  const carried = (await handoff.textContent().catch(() => '')) ?? ''
  check('1 the handoff carries the question answer', carried.includes('answered Blue yes'), carried)
  check('1 and the image you kept', carried.includes('attached images 1'), carried)
  await shot(page, 'switched')

  // 2. Workflow saved with ⌘S (wave 4, R2) and the documents moved to a new folder (wave 4, R6).
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Workflows/ }).click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByRole('textbox', { name: 'Reference name' }).fill('crosscheck')
  await page.locator('.workflow-doc .ProseMirror').click()
  await page.keyboard.type('Check the release plan')
  await page.keyboard.press('Meta+s')
  check('2 the workflow saves', await until('saved', async () => (await page.locator('.workflow-list').getByText('crosscheck').count()) > 0))
  // ⌘S on an existing workflow, right after typing: one save, with the text just typed (R2).
  const saves: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/workflows')) saves.push(`${request.method()} ${request.postData() ?? ''}`) })
  await page.locator('.workflow-list').getByText('crosscheck').first().click()
  await page.locator('.workflow-doc .ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' twice')
  await page.keyboard.press('Meta+s')
  await page.waitForTimeout(800)
  const edited = await getJson<{ data: { name: string; prompt: string }[] }>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`)
  check('2 one ⌘S on an existing workflow sends one save', saves.length === 1, saves.map((s) => s.slice(0, 80)).join(' | '))
  check('2 and keeps the text just typed', edited.data.some((w) => w.name === 'crosscheck' && w.prompt.trim() === 'Check the release plan twice'),
    JSON.stringify(edited.data.map((w) => w.prompt.trim())))
  const moved = await page.evaluate(async ([dir, folder]) => {
    const res = await fetch('/api/documents/location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath: dir, folder }) })
    return { status: res.status, body: await res.text() }
  }, [project, newDocs] as const)
  check('2 the documents move to a folder that takes them', moved.status === 200 && existsSync(join(newDocs, 'release-plan.md')), `${moved.status} ${moved.body.slice(0, 200)}`)

  // 3. Restart: the conversation reopens with its image, its state settled, and carries on.
  //    Nothing it recorded is lost or relabelled across the restart (route Day 12).
  const stored = async (): Promise<{ label: string; events: string[] }> => {
    const rows = await getJson<{ data: { meta: { id: string; title: string; settings: { agent: string } }; messageCount: number }[] }>(page, '/api/threads')
    const row = rows.data.find((t) => t.meta.id === id)
    const events = (await getJson<Detail>(page, `/api/threads/${id}/events`)).data.events.map((e) => JSON.stringify(e))
    return { label: `${row?.meta.title} · ${row?.meta.settings.agent} · ${row?.messageCount}`, events }
  }
  const cardLabel = (): Promise<string> => page.locator('.card').filter({ hasText: 'ask cross-wave' }).first()
    .evaluate((card) => `${card.querySelector('.card-title')?.textContent} · ${card.querySelector('.card-meta')?.textContent}`)
  await page.evaluate((thread) => { location.search = `?thread=${thread}` }, id)
  await page.getByRole('heading', { level: 1, name: 'ask cross-wave' }).waitFor()
  const kept = await stored(), cardBefore = await cardLabel()
  await app.close()
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.evaluate((thread) => { location.search = `?thread=${thread}` }, id)
  await page.getByRole('heading', { level: 1, name: 'ask cross-wave' }).waitFor()
  const reopened = await stored(), cardAfter = await cardLabel()
  check('3 after a restart it keeps its title, agent and message count', reopened.label === kept.label, `${kept.label} → ${reopened.label}`)
  check('3 and every recorded event, unchanged and in order', kept.events.length > 0 && kept.events.every((e, i) => reopened.events[i] === e),
    `${kept.events.length} before, ${reopened.events.length} after; added: ${reopened.events.slice(kept.events.length).join(' ')}`)
  check('3 and its sidebar row reads the same', cardAfter === cardBefore, `${cardBefore} → ${cardAfter}`)
  check('3 after a restart the conversation shows its image', await until('image after restart', () => imagesShown(page)))
  check('3 and is not left Starting or Working', await settled(page), await headText(page))
  await send(page, 'still there?')
  check('3 it carries on with the agent after the restart', await until('reply after restart', async () =>
    (await page.locator('.bubble').filter({ hasText: /^Handoff: / }).count()) === 2, 15_000))
  check('3 and settles again', await until('settled', () => settled(page)), await headText(page))
  await shot(page, 'after-restart')
  const workflows = await getJson<{ data: { name: string; prompt: string }[] }>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`)
  check('3 the workflow is still there', workflows.data.some((w) => w.name === 'crosscheck' && w.prompt.includes('Check the release plan twice')))
  const docs = await getJson<{ data: { custom: boolean } }>(page, `/api/documents/location?projectPath=${encodeURIComponent(project)}`)
  const listed = JSON.stringify(await getJson(page, `/api/documents?projectPath=${encodeURIComponent(project)}`))
  check('3 the project still uses the new documents folder, with its document', docs.data.custom && listed.includes('release-plan.md'))

  // 4. Deleting the conversation removes its images from disk and from the server.
  const detail = await getJson<Detail>(page, `/api/threads/${id}/events`)
  const file = detail.data.events.find((e) => e.event.kind === 'image' && e.event.from === 'you')?.event.file ?? ''
  const imageStatus = (): Promise<number> => page.evaluate(async ([thread, f]) => (await fetch(`/api/threads/${thread}/images/${f}`, { cache: 'no-store' })).status, [id, file] as const)
  check('4 before deleting, the image is served', file !== '' && await imageStatus() === 200, file)
  await page.locator('.thread-actions').getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete conversation…' }).click()
  await page.getByRole('alertdialog', { name: 'Delete conversation' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('heading', { level: 1, name: 'ask cross-wave' }).waitFor({ state: 'detached' })
  check('4 deleting removes its images folder', await until('folder gone', async () => !existsSync(join(store.root, 'attachments', id))))
  // no-store: the window's own HTTP cache keeps an image it already showed (served immutable).
  const after = await imageStatus()
  check('4 and the server no longer serves the image', after === 404, `status ${after}`)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app?.close().catch(() => {})
}
finish('PROOF CROSS-WAVE')
