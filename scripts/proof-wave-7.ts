// Packaged gate for wave 7. So far: W7.1 A12 (workflow conversation titles) and F16 (+ New workflow from the
// new-conversation screen); W7.2 J4 (Changes: working changes, this run, bounded diffs, line targets, non-Git
// and unborn folders); W7.3 K1/K2 (process owners, reuse, finished view, deleting an owner). Stand-in agents only
// (scripts/fixtures/wave65-agent, wave7-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-7
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave7-proof-'))
const project = join(root, 'app')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave7-${name}.png`) })
const get = <T>(page: Page, path: string): Promise<T> => page.evaluate(async (p) => (await (await fetch(p)).json()).data, path) as Promise<T>
const workflowCount = async (page: Page) => (await get<unknown[]>(page, `/api/workflows?projectPath=${encodeURIComponent(project)}`)).length
const threadTitles = async (page: Page) => (await get<Array<{ meta: { title: string } }>>(page, '/api/threads')).map((t) => t.meta.title)
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

// F-GIT for J4: staged, unstaged, untracked, renamed, deleted, binary and conflicted files, with
// repository config that would run a helper if Cockpit let it (the marker must never appear).
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const fgit = join(root, 'fgit')
const marker = join(root, 'helper-ran')
mkdirSync(fgit)
git(fgit, 'init', '-q', '-b', 'main')
writeFileSync(join(fgit, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
writeFileSync(join(fgit, 'gone.txt'), 'removed line one\nremoved line two\n')
writeFileSync(join(fgit, 'old name.txt'), 'same\n'.repeat(20))
writeFileSync(join(fgit, 'both.txt'), 'base\n')
git(fgit, 'add', '.'); git(fgit, 'commit', '-q', '-m', 'first')
git(fgit, 'checkout', '-q', '-b', 'other'); writeFileSync(join(fgit, 'both.txt'), 'theirs\n'); git(fgit, 'commit', '-q', '-am', 'theirs')
git(fgit, 'checkout', '-q', 'main'); writeFileSync(join(fgit, 'both.txt'), 'ours\n'); git(fgit, 'commit', '-q', '-am', 'ours')
try { git(fgit, 'merge', '-q', 'other') } catch { /* the conflict is the point */ }
writeFileSync(join(fgit, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n'); git(fgit, 'add', 'a.txt')
writeFileSync(join(fgit, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\n')
rmSync(join(fgit, 'gone.txt'))
git(fgit, 'mv', 'old name.txt', 'new name.txt')
writeFileSync(join(fgit, 'pre.md'), 'already here before the run\n')
writeFileSync(join(fgit, 'pic.bin'), Buffer.from([1, 0, 2, 0, 3]))
// Configured last, so only Cockpit's own reads could run them from here on.
const helper = join(root, 'helper.sh')
writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`)
chmodSync(helper, 0o755)
for (const [key, value] of [['diff.external', helper], ['diff.evil.textconv', helper], ['core.fsmonitor', helper]]) git(fgit, 'config', key!, value!)
writeFileSync(join(fgit, '.gitattributes'), '*.txt diff=evil\n')
const plain = join(root, 'plain')
mkdirSync(plain)
const unborn = join(root, 'unborn')
mkdirSync(unborn)
git(unborn, 'init', '-q', '-b', 'main')
writeFileSync(join(unborn, 'first.txt'), 'hello\n')

/** A new conversation in the active project, past Recent work, that waits until it is open. */
async function converse(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).fill(prompt)
  await messageBox(page).press('Enter')
  await page.locator('.thread-head h1').waitFor()
}
const idle = (page: Page): Promise<boolean> => until('turn end', async () => await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0, 30_000)

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Wave 7')
  const review = await apiPost(page, '/api/workflows', { projectPath: project, name: 'review', title: 'Code review', prompt: 'Review the changes' }) as { data: { id: string } }
  await page.reload()
  await page.getByRole('button', { name: 'New conversation' }).click()
  // A project opened for the first time offers its recent work; Start fresh is the plain empty state.
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click()

  // F16 / W7-02: + New workflow beside Browse workflows; the editor opens with its instructions focused, the draft stays.
  const links = page.locator('.workflow-card-links')
  check('W7-02 + New workflow sits beside Browse workflows', await links.getByRole('button', { name: 'Browse workflows →' }).isVisible()
    && await links.getByRole('button', { name: '+ New workflow' }).isVisible())
  await shot(page, 'start-links')
  await messageBox(page).fill('half-typed idea about the login page')
  await links.getByRole('button', { name: '+ New workflow' }).click()
  const editor = page.locator('.workflow-editor')
  await editor.waitFor()
  check('W7-02 the editor opens on the new-conversation screen', await page.locator('.new-conversation .workflow-editor').isVisible())
  check('W7-02 its instructions have focus', await until('instructions focus', () => page.evaluate(() => Boolean(document.activeElement?.closest('.workflow-doc')))))
  check('W7-02 it only saves: no run or schedule from here', await editor.getByRole('button', { name: 'Save and run' }).count() === 0
    && await editor.getByRole('button', { name: 'Save and enable schedule' }).count() === 0)
  await shot(page, 'editor-open')

  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  check('W7-02 Cancel saves nothing', await workflowCount(page) === 1)
  check('W7-02 Cancel restores the draft and the focus', await messageBox(page).inputValue() === 'half-typed idea about the login page'
    && await until('composer focus', () => messageBox(page).evaluate((el) => el === document.activeElement)))

  await links.getByRole('button', { name: '+ New workflow' }).click()
  await editor.getByLabel('Title', { exact: true }).fill('Release notes')
  await editor.getByLabel('Reference name', { exact: true }).fill('release-notes')
  await editor.locator('.workflow-doc .ProseMirror').click()
  await page.keyboard.type('Write the release notes')
  await editor.getByRole('button', { name: 'Save workflow', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  check('W7-02 Save creates exactly one workflow', await until('one saved', async () => await workflowCount(page) === 2))
  check('W7-02 Save starts nothing', (await threadTitles(page)).length === 0)
  check('W7-02 the draft and focus come back after Save', await messageBox(page).inputValue() === 'half-typed idea about the login page'
    && await until('composer focus', () => messageBox(page).evaluate((el) => el === document.activeElement)))
  check('W7-02 the new workflow is offered as a card', await until('card', () => page.locator('.workflow-card', { hasText: 'Release notes' }).isVisible()))

  // A12 / W7-01: a conversation started from a workflow card is "@<workflow>"; a manual run uses the same rule.
  await messageBox(page).fill('')
  await page.locator('.workflow-card', { hasText: 'Code review' }).click()
  await messageBox(page).press('End')
  await messageBox(page).pressSequentially(' for the login page')
  await messageBox(page).press('Enter')
  check('W7-01 a card-started conversation is titled @Code review in the header', await until('header title',
    async () => (await page.locator('.thread-head h1').textContent())?.trim() === '@Code review'))
  check('W7-01 and in the list', await page.getByRole('navigation', { name: 'Conversations' }).getByText('@Code review', { exact: true }).first().isVisible())
  await shot(page, 'card-title')
  await apiPost(page, `/api/workflows/${review.data.id}/run`, {}).catch(() => undefined)
  check('W7-01 a manual run uses the same title', await until('run title', async () => (await threadTitles(page)).filter((t) => t === '@Code review').length >= 1))

  // J4 / W7-03..05: Changes. A "work" turn runs 12 s; the folder is edited from outside meanwhile.
  await openProject(page, fgit, 'F-GIT')
  await converse(page, 'work on the parser')
  const changes = page.getByRole('region', { name: 'Changes' })
  check('W7-05 the run starts working', await until('working', async () => await page.getByRole('button', { name: 'Stop', exact: true }).count() === 1))
  await new Promise((r) => setTimeout(r, 1500))
  writeFileSync(join(fgit, 'during.txt'), 'written while the run worked\n')
  writeFileSync(join(fgit, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n')
  check('W7-05 the run ends', await idle(page))
  await page.locator('.note').getByRole('button', { name: 'Changes', exact: true }).last().click()
  await changes.waitFor()
  check('W7-05 a run’s note opens This run', await changes.getByRole('tab', { name: 'This run' }).getAttribute('aria-selected') === 'true')
  const runList = changes.getByRole('list', { name: 'Changed during this run' })
  check('W7-05 a file written during the run is listed as changed during it', await until('run list', () => runList.getByRole('button', { name: /during\.txt.*Changed during this run/ }).isVisible()))
  check('W7-05 a file already changed is “changed again”, not the run’s own', await runList.getByRole('button', { name: /a\.txt.*Already changed before; changed again/ }).isVisible())
  check('W7-05 untouched earlier changes are counted, not claimed', await runList.getByText('pre.md').count() === 0
    && await changes.getByText(/files were already changed when the run started/).isVisible())
  check('W7-05 no authorship claim', await changes.getByText('Cockpit can’t tell who made each change.').isVisible()
    && await changes.getByText(/by the agent|agent’s changes|agent made/i).count() === 0)
  await shot(page, 'changes-run')

  await changes.getByRole('tab', { name: 'Working changes' }).click()
  const fileList = changes.getByRole('list', { name: 'Changed files' })
  await fileList.waitFor()
  const head = git(fgit, 'rev-parse', 'HEAD').trim()
  check('W7-03 the base is HEAD on main, by commit', await changes.getByText(`Against HEAD ${head.slice(0, 8)} on main`).isVisible())
  const rows = (await fileList.getByRole('button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
  const row = (text: string) => rows.find((r) => r.includes(text)) ?? ''
  check('W7-03 exact paths: eight changed files', rows.length === 8, rows.join(' | '))
  check('W7-03 partly staged with counts', /^M.*a\.txt.*Partly staged.*\+3.*−1/.test(row('a.txt')), row('a.txt'))
  check('W7-03 conflicted', row('both.txt').startsWith('!'), row('both.txt'))
  check('W7-03 deleted, unstaged', /^D.*gone\.txt.*Not staged.*−2/.test(row('gone.txt')), row('gone.txt'))
  check('W7-03 renamed by old and new path', /^R.*old name\.txt → new name\.txt.*Staged/.test(row('new name.txt')), row('new name.txt'))
  check('W7-03 untracked binary', /^U.*pic\.bin.*Binary/.test(row('pic.bin')), row('pic.bin'))
  check('W7-03 one conflict is called out', await changes.getByText(/1 file has a merge conflict/).isVisible())

  // A right-side line opens Files at that line; a removed line opens the base revision read-only.
  await fileList.getByRole('button', { name: /a\.txt/ }).click()
  const diff = changes.getByRole('table', { name: 'Diff of a.txt' })
  await diff.waitFor()
  await diff.getByRole('row').filter({ hasText: 'seven' }).click()
  const selection = () => page.getByRole('textbox', { name: 'File contents' }).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))
  check('W7-03 a right-side line opens Files at its current line', await until('editor line', async () => (await selection()) === 'seven'), await selection().catch(() => ''))
  await shot(page, 'changes-open-line')
  await page.getByRole('tab', { name: /^Conversations/ }).click()
  await page.locator('.thread-head').getByRole('button', { name: 'Changes', exact: true }).click()
  await changes.getByRole('tab', { name: 'Working changes' }).click().catch(() => undefined)
  await fileList.getByRole('button', { name: /gone\.txt/ }).click()
  await changes.getByRole('table', { name: 'Diff of gone.txt' }).getByRole('row').filter({ hasText: 'removed line two' }).click()
  const history = changes.getByRole('region', { name: `gone.txt at ${head.slice(0, 8)} (read-only)` })
  check('W7-03 a deleted line opens the base revision, labelled and read-only', await until('history', () => history.isVisible())
    && await history.locator('.diff-target').textContent() === '2removed line two')
  await shot(page, 'changes-history')
  await fileList.getByRole('button', { name: /pic\.bin/ }).click()
  check('W7-03 a binary file shows metadata, not text', await until('binary', () => changes.getByText(/A binary file: no text diff/).isVisible()))
  check('W7-03 no diff, textconv or fsmonitor helper ran', !existsSync(marker))

  // The file changes after it was read: the line is not opened somewhere else.
  await fileList.getByRole('button', { name: /a\.txt/ }).click()
  await diff.waitFor()
  writeFileSync(join(fgit, 'a.txt'), 'rewritten entirely\n')
  await diff.getByRole('row').filter({ hasText: 'seven' }).click()
  check('W7-03 a line that moved since the read says so instead of opening', await until('stale', () => changes.getByRole('alert').filter({ hasText: 'changed since it was read' }).isVisible()))
  await changes.getByRole('alert').getByRole('button', { name: 'Refresh' }).click()

  for (const theme of ['Light', 'Dark'] as const) {
    await setTheme(page, theme)
    await shot(page, `changes-${theme.toLowerCase()}`)
  }
  await page.setViewportSize({ width: 700, height: 760 })
  await shot(page, 'changes-narrow')
  check('narrow: Changes fits without sideways scroll', await changes.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  await page.setViewportSize({ width: 1280, height: 800 })

  // W7-04: a folder that is not a repository, and one with no commits yet.
  await openProject(page, plain, 'Plain folder')
  await converse(page, 'hello')
  await idle(page)
  await page.locator('.thread-head').getByRole('button', { name: 'Changes', exact: true }).click()
  check('W7-04 a non-Git folder says Git changes unavailable', await until('unavailable', () => changes.getByText('Git changes unavailable').isVisible()))
  await openProject(page, unborn, 'Unborn repo')
  await converse(page, 'hello')
  await idle(page)
  await page.locator('.thread-head').getByRole('button', { name: 'Changes', exact: true }).click()
  check('W7-04 an unborn repository compares with an empty base, no invented HEAD', await until('empty base', () => changes.getByText(/Against an empty base: this repository has no commits yet/).isVisible())
    && await changes.getByText(/Against HEAD/).count() === 0)
  await page.getByRole('tab', { name: /^Conversations/ }).click()
  const closeChanges = page.getByRole('button', { name: 'Close', exact: true })
  if (await closeChanges.isVisible()) await closeChanges.click()

  // W7-08..10: the packaged result card keeps provider/user/host evidence separate, runs one
  // exact finite command, exposes freshness, captures without claiming correctness, and cancels
  // only its owned process group even when the command traps TERM and exits zero.
  const card = page.locator('.result-card').last()
  check('W7-08 the result summary separates provider Ready from user Complete', await until('result card', () => card.isVisible())
    && (await card.locator('summary').textContent())?.includes('Agent turn ready') === true
    && (await card.locator('summary').textContent())?.includes('Conversation open') === true)
  await card.locator('summary').click()
  check('W7-08 no check is not shown as green', await card.getByText(/No host checks were run/).isVisible())
  check('W7-08 agent prose is visibly not a host check', await card.getByRole('heading', { name: 'Agent report' }).isVisible()
    && await card.getByText('The agent’s words are not a host check.').isVisible())

  await card.getByLabel('Exact command').fill("printf '3 tests ran\\n'")
  await card.getByLabel('Required output (optional)').fill('0 failed')
  await card.getByLabel('Freshness inputs (comma-separated)').fill('first.txt')
  await card.getByRole('button', { name: 'Run exactly this check' }).click()
  check('W7-08 zero exit fails the visible narrow criterion', await until('narrow failure', () => card.getByText('Failed', { exact: true }).isVisible())
    && await card.getByText(/output did not include “0 failed”/).isVisible())

  await card.getByLabel('Exact command').fill('cat first.txt')
  await card.getByLabel('Required output (optional)').fill('')
  await card.getByRole('button', { name: 'Run exactly this check' }).click()
  check('W7-09 a real host pass is recorded', await until('host pass', () => card.getByText('Passed', { exact: true }).isVisible()))
  writeFileSync(join(unborn, 'first.txt'), 'changed after check\n')
  await page.reload()
  await page.getByRole('navigation', { name: 'Conversations' }).getByText('hello', { exact: true }).first().click()
  const reloadedCard = page.locator('.result-card').last()
  await reloadedCard.waitFor()
  await reloadedCard.locator('summary').click()
  check('W7-09 editing a declared input makes the pass stale after reload', await until('stale check', () => reloadedCard.getByText('stale', { exact: true }).first().isVisible()))

  const previewServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Wave 7 preview</h1>') })
  await new Promise<void>((resolve) => previewServer.listen(0, '127.0.0.1', resolve))
  const previewUrl = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}/`
  try {
    await reloadedCard.getByLabel('Local preview URL').fill(previewUrl)
    await reloadedCard.getByRole('button', { name: 'Capture preview' }).click()
    check('W7-09 capture is visible but not a visual pass', await until('capture', () => reloadedCard.getByText('Captured, not yet judged').isVisible()))
    await reloadedCard.getByRole('button', { name: 'Looks wrong' }).click()
    check('W7-09 human visual judgement stays separate', await until('assessment', () => reloadedCard.getByText('Marked as looking wrong by you').isVisible()))

    await reloadedCard.getByLabel('Exact command').fill("trap 'exit 0' TERM; sleep 30 & wait")
    await reloadedCard.getByRole('button', { name: 'Run exactly this check' }).click()
    const cancel = reloadedCard.getByRole('button', { name: 'Cancel', exact: true })
    await cancel.waitFor()
    await cancel.click()
    check('W7-10 cancellation wins over the command’s late zero exit', await until('cancelled', () => reloadedCard.getByText('Cancelled', { exact: true }).isVisible()))
    check('W7-10 the unrelated preview server remains alive', await fetch(previewUrl).then((response) => response.text()).then((text) => text.includes('Wave 7 preview'), () => false))
    for (const theme of ['Light', 'Dark'] as const) {
      await setTheme(page, theme)
      await shot(page, `result-card-${theme.toLowerCase()}`)
    }
    await page.setViewportSize({ width: 700, height: 760 })
    await shot(page, 'result-card-narrow')
    check('narrow: the result card fits without sideways scroll', await reloadedCard.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    await page.setViewportSize({ width: 1280, height: 800 })
  } finally {
    await new Promise<void>((resolve) => previewServer.close(() => resolve()))
  }
  await setTheme(page, 'Light')

  await openProject(page, project, 'Wave 7')
  for (const theme of ['Light', 'Dark'] as const) {
    await setTheme(page, theme)
    await page.getByRole('button', { name: 'New conversation' }).click()
    const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
    if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
    await page.locator('.workflow-card-links').getByRole('button', { name: '+ New workflow' }).click()
    await shot(page, `editor-${theme.toLowerCase()}`)
    await page.locator('.workflow-editor').getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await page.setViewportSize({ width: 980, height: 760 })
  await shot(page, 'start-narrow')
  check('narrow: the link row stays inside the start screen', await page.locator('.workflow-card-links').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
} catch (error) {
  console.log(`FAIL  unexpected: ${error instanceof Error ? error.message : String(error)}`)
  await shot(page, 'failure').catch(() => undefined)
  console.log('  alerts:', await page.getByRole('alert').allTextContents().catch(() => []))
  console.log('  doc:', await page.locator('.workflow-doc .ProseMirror').textContent().catch(() => '?'))
  check('proof ran to the end', false)
} finally {
  await app.close()
}
// K1/K2 / W7-06..07: process ownership, in a second launch whose stand-in starts "dev server" through
// the cockpit MCP API with each conversation's own token.
const procs = join(root, 'procs')
const procsOther = join(root, 'procs-other')
const SERVER = `const http = require('node:http')
http.createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log('Local: http://127.0.0.1:' + this.address().port + '/') })`
for (const dir of [procs, procsOther]) { mkdirSync(dir); writeFileSync(join(dir, 'server.js'), SERVER); writeFileSync(join(dir, 'other.js'), SERVER) }
interface Proc { id: string; name: string; status: string; pid?: number; url?: string; projectPath: string; owner: { kind: string; title?: string; formerly?: string }; sharedWith?: Array<{ title: string }> }
const app2 = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state-procs'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave7-agent') })
const p2 = await app2.firstWindow()
const procList = async (dir: string): Promise<Proc[]> => (await get<Proc[]>(p2, '/api/processes')).filter((p) => p.projectPath === dir)
const running = async (dir: string): Promise<Proc[]> => (await procList(dir)).filter((p) => p.status === 'running')
const lastReply = async (title: string): Promise<string> => {
  const thread = (await get<Array<{ meta: { id: string; title: string } }>>(p2, '/api/threads')).find((t) => t.meta.title === title)
  if (!thread) return ''
  const detail = await get<{ events: Array<{ event: { kind: string; text?: string } }> }>(p2, `/api/threads/${thread.meta.id}/events`)
  return detail.events.filter((e) => e.event.kind === 'assistant_text').at(-1)?.event.text ?? ''
}
const approvedProcessStarts = new Set<string>()
const approveProcessStart = async (threadId: string, label: string): Promise<void> => {
  let requestId = ''
  await until(`${label} process approval`, async () => {
    const detail = await get<{ events: Array<{ event: { kind: string; requestId?: string; toolName?: string } }> }>(p2, `/api/threads/${threadId}/events`)
    requestId = detail.events.findLast((event) => event.event.kind === 'approval_request'
      && event.event.toolName === 'mcp__cockpit__start_process' && !approvedProcessStarts.has(event.event.requestId ?? ''))?.event.requestId ?? ''
    return Boolean(requestId)
  })
  if (requestId) {
    approvedProcessStarts.add(requestId)
    await apiPost(p2, `/api/threads/${threadId}/approvals/${requestId}`, { behavior: 'allow' })
  }
}
const startIn = async (dir: string, title: string, text = 'start the dev server'): Promise<void> => {
  const created = await apiPost(p2, '/api/threads', { projectPath: dir, title, text, settings: { agent: 'claude' } }) as { data: { id: string } }
  await approveProcessStart(created.data.id, title)
}
let alivePid = 0
try {
  p2.setDefaultTimeout(15_000)
  await openProject(p2, procsOther, 'Other folder')
  await openProject(p2, procs, 'Procs')
  await startIn(procs, 'Login work', 'start the dev server login-preview')
  check('W7-06 an agent’s start records its conversation as owner', await until('owned', async () => (await running(procs))[0]?.owner.title === 'Login work', 15_000))
  await startIn(procs, 'Docs work', 'start the dev server docs-preview')
  check('W7-06 a second conversation reuses it (same command) and sees the original owner', await until('reused', async () => (await lastReply('Docs work')).includes('HTTP 201'))
    && (await running(procs)).length === 1 && (await running(procs))[0]!.owner.title === 'Login work'
    && (await running(procs))[0]!.sharedWith?.[0]?.title === 'Docs work')
  await startIn(procs, 'Clash', 'start the other-command server')
  check('W7-06 the same name with a different command is refused', await until('conflict', async () => (await lastReply('Clash')).includes('HTTP 409'))
    && (await running(procs)).length === 1)
  await startIn(procsOther, 'Elsewhere')
  check('W7-06 another workspace starts its own, independently', await until('other', async () => (await running(procsOther)).length === 1)
    && (await running(procs)).length === 1)
  alivePid = (await running(procsOther))[0]!.pid ?? 0

  const threads = await get<Array<{ meta: { id: string; title: string } }>>(p2, '/api/threads')
  const docs = threads.find((t) => t.meta.title === 'Docs work')!
  const conversations = p2.getByRole('navigation', { name: 'Conversations' })
  check('W7.3 previews opened by background conversations do not replace the workspace pane', await p2.getByRole('complementary', { name: 'App preview' }).count() === 0)
  await conversations.getByText('Login work', { exact: true }).first().click()
  const previewAddress = p2.locator('.preview-address code')
  check('W7.3 selecting a conversation reveals only its own preview', await until('Login preview', async () => (await previewAddress.textContent())?.endsWith('/login') === true))
  await shot(p2, 'preview-owner-login')
  await apiPost(p2, `/api/threads/${docs.meta.id}/messages`, { text: 'start the dev server docs-updated-preview' })
  await approveProcessStart(docs.meta.id, 'Docs updated preview')
  check('W7.3 a background conversation can update its preview', await until('Docs updated preview', async () => (await lastReply('Docs work')).includes('docs-updated')))
  check('W7.3 that background update never replaces the visible conversation preview', (await previewAddress.textContent())?.endsWith('/login') === true)
  await conversations.getByText('Docs work', { exact: true }).first().click()
  check('W7.3 the updated preview is waiting when its owner comes on screen', await until('updated Docs preview', async () => (await previewAddress.textContent())?.endsWith('/docs-updated') === true))
  await shot(p2, 'preview-owner-docs')

  await p2.getByRole('button', { name: /^Processes/ }).click()
  const group = p2.getByRole('region', { name: 'Login work' })
  check('W7-06 Processes groups it under its owner', await until('group', () => group.getByRole('button', { name: /dev server/ }).isVisible()))
  check('W7-06 the row names the owner and who else uses it', await p2.getByText('Started by “Login work” · also used by “Docs work”').isVisible())
  await p2.getByRole('button', { name: 'Open site', exact: true }).click()
  check('W7.3 Open site routes to the process owner conversation', await until('owner conversation', async () => (await p2.locator('.thread-head h1').textContent())?.trim() === 'Login work'))
  check('W7.3 Open site replaces only that owner’s preview', (await previewAddress.textContent()) === (await running(procs))[0]?.url)
  await p2.getByRole('button', { name: /^Processes/ }).click()
  await shot(p2, 'processes-owned')
  await p2.getByRole('button', { name: 'Stop', exact: true }).click()
  check('W7-07 a stopped process leaves the running list', await until('stopped', async () => (await running(procs)).length === 0
    && await p2.getByText('Nothing running. Finished ones are under Show finished.').isVisible()))
  await p2.getByRole('button', { name: /^Show finished/ }).click()
  check('W7-07 Show finished keeps its history', await group.getByRole('button', { name: /dev server/ }).isVisible())
  await shot(p2, 'processes-finished')
  await p2.getByRole('button', { name: 'Clear finished' }).click()
  check('W7-07 Clear finished drops the rows and stops nothing', await until('cleared', async () => (await procList(procs)).length === 0)
    && alivePid > 0 && (() => { try { process.kill(alivePid, 0); return true } catch { return false } })())

  // Deleting the owner needs a decision; Keep moves the server to Project processes, still running.
  await apiPost(p2, `/api/threads/${(await get<Array<{ meta: { id: string; title: string } }>>(p2, '/api/threads')).find((t) => t.meta.title === 'Login work')!.meta.id}/messages`, { text: 'start it again' })
  await until('restarted', async () => (await running(procs)).length === 1)
  await p2.getByRole('tab', { name: /^Conversations/ }).click()
  await p2.getByRole('navigation', { name: 'Conversations' }).getByText('Login work', { exact: true }).first().click()
  await p2.getByRole('button', { name: 'More', exact: true }).click()
  await p2.getByRole('menuitem', { name: /Delete conversation/ }).or(p2.getByRole('button', { name: /Delete conversation/ })).first().click()
  const dialog = p2.getByRole('alertdialog', { name: 'Delete conversation' })
  check('W7-07 deleting the owner lists its running process', await dialog.getByRole('list', { name: 'Processes this conversation owns' }).getByText('dev server').isVisible())
  check('W7-07 and offers only Stop or Keep', await dialog.getByRole('button', { name: 'Stop owned processes' }).isVisible()
    && await dialog.getByRole('button', { name: 'Keep as project processes' }).isVisible() && await dialog.getByRole('button', { name: 'Delete', exact: true }).count() === 0)
  await shot(p2, 'processes-delete-decision')
  await dialog.getByRole('button', { name: 'Keep as project processes' }).click()
  check('W7-07 Keep: the server runs on as a project process, never another conversation’s', await until('kept', async () => {
    const [p] = await running(procs)
    return p?.owner.kind === 'project' && p.owner.formerly === 'Login work'
  }))
  await p2.getByRole('button', { name: /^Processes/ }).click()
  check('W7-07 it shows under Project processes', await until('project group', () => p2.getByRole('region', { name: 'Project processes' }).getByRole('button', { name: /dev server/ }).isVisible()))
  for (const theme of ['Light', 'Dark'] as const) {
    await setTheme(p2, theme)
    await shot(p2, `processes-${theme.toLowerCase()}`)
  }
  await p2.setViewportSize({ width: 700, height: 760 })
  await shot(p2, 'processes-narrow')
  check('narrow: Processes fits without sideways scroll', await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
} catch (error) {
  console.log(`FAIL  unexpected (processes): ${error instanceof Error ? error.message : String(error)}`)
  await shot(p2, 'processes-failure').catch(() => undefined)
  check('process proof ran to the end', false)
} finally {
  await app2.close()
}
finish('PROOF WAVE 7')
