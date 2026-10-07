// Packaged gate for wave 12 part 2 (order 18): W12-09 – W12-15 on the PACKAGED app with the
// stand-in agent scripts/fixtures/wave12-agent (HOLD keeps a turn running until Stop; START-PROC
// starts a process through Cockpit's MCP API; LINK names notes.txt in its reply).
//
//   W12-15  one conversation, two agents at once (main checkout and Rose bed): Stop one, Stop all,
//           Complete blocked until both are idle (queued input per workspace: unit-tested).
//   W12-12  removal refused for untracked, ignored, unmerged-commit and running-process worktrees;
//           archive keeps everything; restore.
//   W12-13  a clean merged worktree is removed with Git (branch kept); its conversation's file link
//           then opens nothing, never the main checkout's copy.
//   W12-14  a worktree moved and one deleted outside Cockpit, then Quit/reopen: reported, not pruned.
//   W12-09  merge back: fast-forward, merge commit, approval made stale by a new main commit.
//   W12-10  dirty main, a working agent and the target branch checked out elsewhere block a merge.
//   W12-11  conflict → Continue; conflict → Abort; a REAL crash after Git merged (COCKPIT_PROOF_MERGE_CRASH)
//           reopens the recorded conflict, never merges twice.
//
// Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-12-lifecycle
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject } from './lib/ui.ts'

const { check, finish } = checker()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-wave12-lifecycle-')))
const state = join(root, 'state'), garden = join(root, 'garden')
mkdirSync(state, { recursive: true })
mkdirSync(garden)
const ident = { GIT_AUTHOR_NAME: 'Gardener', GIT_AUTHOR_EMAIL: 'g@example.invalid', GIT_COMMITTER_NAME: 'Gardener', GIT_COMMITTER_EMAIL: 'g@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } }).trim()
const commit = (cwd: string, file: string, text: string, message: string): string => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}
git(garden, 'init', '-q', '-b', 'main')
// The repository's own identity: merge commits need one, and Cockpit never sets it.
git(garden, 'config', 'user.name', 'Gardener')
git(garden, 'config', 'user.email', 'g@example.invalid')
writeFileSync(join(garden, '.gitignore'), 'build/\n')
writeFileSync(join(garden, 'notes.txt'), 'main notes\n')
commit(garden, 'beds.txt', 'roses\ntulips\n', 'first')
git(garden, 'add', '.')
git(garden, 'commit', '-q', '-m', 'notes')
mkdirSync(PROOF_DIR, { recursive: true })

// ---------- helpers ----------
const step = (label: string): void => console.log(`  · ${label}`)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave12b-${name}.png`) })
async function until<T>(label: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`  (timed out waiting for ${label})`)
  return undefined
}
interface Answer<T> { status: number; data?: T; error?: string }
const call = <T>(page: Page, method: string, path: string, body?: unknown): Promise<Answer<T>> => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(p as string, { method: m as string, headers: { 'content-type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
  const json = await res.json().catch(() => ({})) as { data?: unknown; error?: string }
  return { status: res.status, data: json.data, error: json.error }
}, [method, path, body] as const) as Promise<Answer<T>>
const get = async <T>(page: Page, path: string): Promise<T> => (await call<T>(page, 'GET', path)).data as T
interface Workspace { id: string; kind: string; cwd: string; name?: string; branch?: string; lifecycle: string }
interface Detail { meta: { id: string; workspaceId?: string; completed: boolean }; status: string; events: Array<{ event: { kind: string; text?: string; ok?: boolean; stopped?: boolean }; workspaceId?: string }>; runs?: Array<{ workspaceId: string; working: boolean }> }
const sleepers = (): string[] => { try { return execFileSync('/usr/bin/pgrep', ['-f', '^sleep 600$'], { encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] } }
const before = sleepers()

const choose = async (page: Page, label: RegExp): Promise<void> => {
  await page.getByRole('button', { name: /^Workspace:/ }).first().click()
  const list = page.getByRole('listbox', { name: 'Workspaces' })
  await list.getByRole('option', { name: label }).click()
  await list.waitFor({ state: 'detached' })
}
const manage = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /^Workspace:/ }).first().click()
  await page.getByRole('button', { name: /Manage worktrees/ }).click()
  const dialog = page.getByRole('dialog', { name: /Worktrees of/ })
  await dialog.waitFor()
  return dialog
}
const closeManage = async (page: Page): Promise<void> => { await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: /Worktrees of/ }).waitFor({ state: 'detached' }) }
const row = (dialog: Locator, name: string): Locator => dialog.getByRole('listitem', { name, exact: true })
const runs = async (page: Page, id: string) => (await get<Detail>(page, `/api/threads/${id}/events`)).runs ?? []
const workingIn = async (page: Page, id: string): Promise<string[]> => (await runs(page, id)).filter((r) => r.working).map((r) => r.workspaceId).sort()

const launch = (extra: Record<string, string> = {}): Promise<ElectronApplication> => launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave12-agent'), ...extra })

let app: ElectronApplication | undefined
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, garden, 'Garden')
  const project = (await get<Array<{ path: string; projectId: string }>>(page, '/api/projects')).find((p) => p.path === garden)!
  const pid = project.projectId
  const make = async (name: string): Promise<Workspace> => (await call<{ workspace: Workspace }>(page, 'POST', `/api/projects/${pid}/workspaces`, { name })).data!.workspace
  const rose = await make('Rose bed')
  const pond = await make('Pond')
  const list = async () => get<{ workspaces: Workspace[]; health: Record<string, { state: string }> }>(page, `/api/projects/${pid}/workspaces`)
  const primary = (await list()).workspaces.find((w) => w.kind === 'primary')!
  await page.reload()
  await page.getByRole('button', { name: /^Workspace:/ }).first().waitFor()

  // ======================= W12-15: two agents at once in one conversation =======================
  step('W12-15 main checkout and Rose bed working at the same time')
  await choose(page, /Main checkout/)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill('HOLD the main checkout plan')
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: /HOLD the main checkout/ }).waitFor()
  const threadId = (await until('conversation', async () => (await get<Array<{ meta: { id: string; projectPath: string } }>>(page, '/api/threads')).find((t) => t.meta.projectPath === garden)?.meta.id))!
  await until('main working', async () => (await workingIn(page, threadId)).includes(primary.id))
  await choose(page, /Rose bed/)
  await messageBox(page).fill('HOLD the rose bed sketch')
  await messageBox(page).press('Enter')
  const both = await until('both working', async () => (await workingIn(page, threadId)).length === 2)
  check('W12-15 one conversation runs two agents at once, one per workspace', Boolean(both), (await workingIn(page, threadId)).join(','))
  await page.getByRole('button', { name: 'Stop all' }).waitFor()
  check('W12-15 the header offers Stop for the focused workspace and Stop all', await page.getByRole('button', { name: 'Stop Rose bed' }).count() === 1)
  check('W12-15 messages are labelled by the workspace they ran in', await page.locator('.author-where', { hasText: 'Rose bed' }).count() >= 1 && await page.locator('.author-where', { hasText: 'Main checkout' }).count() >= 1)
  await shot(page, '15-two-running')
  // Queueing mid-turn input into one workspace's agent is proven in tests/concurrent-workspaces.test.ts:
  // the stand-in answers every message at once instead of queueing like a real CLI.
  const completeEarly = await call(page, 'POST', `/api/threads/${threadId}/completed`, { completed: true })
  check('W12-15 Complete is refused while either agent works', completeEarly.status === 409, completeEarly.error ?? '')
  await page.getByRole('button', { name: 'Stop Rose bed' }).click()
  const oneLeft = await until('rose stopped', async () => { const w = await workingIn(page, threadId); return w.length === 1 && w[0] === primary.id })
  check('W12-15 Stop for Rose bed stops only Rose bed; the main checkout keeps working', Boolean(oneLeft))
  await shot(page, '15-one-stopped')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await until('all stopped', async () => (await workingIn(page, threadId)).length === 0)
  const d2 = await get<Detail>(page, `/api/threads/${threadId}/events`)
  const stoppedByWorkspace = d2.events.filter((e) => e.event.kind === 'result' && e.event.stopped).map((e) => e.workspaceId).sort()
  check('W12-15 each workspace\'s run ends as stopped, on its own record', stoppedByWorkspace.join() === [primary.id, rose.id].sort().join(), stoppedByWorkspace.join())
  const completed = await call(page, 'POST', `/api/threads/${threadId}/completed`, { completed: true })
  check('W12-15 Complete is allowed once both are idle', completed.status === 200)
  check('W12-15 no held agent process is left', sleepers().filter((p) => !before.includes(p)).length === 0)

  // ======================= W12-12: removal never loses work =======================
  step('W12-12 untracked, ignored, unmerged commit and running process each refuse removal')
  writeFileSync(join(rose.cwd, 'sketch.txt'), 'only in the rose bed\n')
  mkdirSync(join(pond.cwd, 'build'))
  writeFileSync(join(pond.cwd, 'build', 'out.js'), 'built\n')
  const lilies = await make('Lilies')
  commit(lilies.cwd, 'lilies.txt', 'white\n', 'only on the lilies branch')
  let dialog = await manage(page)
  const tryRemove = async (name: string): Promise<string> => {
    await row(dialog, name).getByRole('button', { name: 'Remove…' }).click()
    return (await row(dialog, name).locator('.worktree-check').textContent({ timeout: 10_000 })) ?? ''
  }
  const roseSays = await tryRemove('Rose bed')
  const pondSays = await tryRemove('Pond')
  const liliesSays = await tryRemove('Lilies')
  check('W12-12 an untracked file blocks removal, in words', /would lose 1 untracked file/.test(roseSays), roseSays)
  check('W12-12 ignored files block removal (never assumed disposable)', /would lose 1 ignored file/.test(pondSays), pondSays)
  check('W12-12 a commit on no other branch blocks removal', /would lose 1 commit on no other branch/.test(liliesSays), liliesSays)
  await shot(page, '12-unique-work')
  await closeManage(page)
  // A process started by the agent in Pond.
  await choose(page, /Pond/)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill('START-PROC in the pond')
  await messageBox(page).press('Enter')
  const approval = page.locator('.approval.open')
  await approval.waitFor({ timeout: 30_000 })
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  await until('pond process', async () => (await get<Array<{ name: string; status: string; workspaceId?: string }>>(page, '/api/processes')).some((p) => p.name === 'wt-sleeper' && p.status === 'running' && p.workspaceId === pond.id))
  dialog = await manage(page)
  const busySays = await tryRemove('Pond')
  check('W12-12 a running process blocks removal and names itself', /Process wt-sleeper is running in it/.test(busySays), busySays)
  await closeManage(page)
  const procs = await get<Array<{ id: string; name: string }>>(page, '/api/processes')
  for (const p of procs.filter((x) => x.name === 'wt-sleeper')) await call(page, 'POST', `/api/processes/${p.id}/stop`, {})
  await until('process stopped', async () => !(await get<Array<{ name: string; status: string }>>(page, '/api/processes')).some((p) => p.name === 'wt-sleeper' && p.status === 'running'))
  dialog = await manage(page)
  await row(dialog, 'Lilies').getByRole('button', { name: 'Archive' }).click()
  await until('lilies archived', async () => (await list()).workspaces.find((w) => w.id === lilies.id)?.lifecycle === 'archived')
  check('W12-12 Archive keeps the folder, its files and its unmerged commit exactly as they were',
    existsSync(join(lilies.cwd, 'lilies.txt')) && git(lilies.cwd, 'log', '-1', '--format=%s') === 'only on the lilies branch' && git(garden, 'branch', '--list', 'codex/lilies').includes('codex/lilies'))
  await row(dialog, 'Lilies').getByRole('button', { name: 'Restore' }).click()
  check('W12-12 Restore puts an archived worktree back in use', Boolean(await until('lilies active', async () => (await list()).workspaces.find((w) => w.id === lilies.id)?.lifecycle === 'active')))
  check('W12-12 nothing in the main checkout changed', git(garden, 'status', '--porcelain') === '' && readFileSync(join(garden, 'notes.txt'), 'utf8') === 'main notes\n')
  await closeManage(page)

  // ======================= W12-13: remove a clean merged worktree; its links stay its own =======================
  step('W12-13 a conversation in Tidy names a file, then Tidy is removed')
  const tidy = await make('Tidy')
  writeFileSync(join(tidy.cwd, 'notes.txt'), 'main notes\n')
  await page.reload()
  await choose(page, /Tidy/)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill('LINK tidy the notes')
  await messageBox(page).press('Enter')
  await page.locator('.file-link[data-path="notes.txt"]').first().waitFor({ timeout: 30_000 })
  const tidyThread = (await get<Array<{ meta: { id: string; title: string } }>>(page, '/api/threads')).find((t) => t.meta.title.startsWith('LINK tidy'))!.meta.id
  dialog = await manage(page)
  await row(dialog, 'Tidy').getByRole('button', { name: 'Remove…' }).click()
  await row(dialog, 'Tidy').getByRole('button', { name: 'Remove with Git' }).click()
  await until('tidy removed', async () => (await list()).workspaces.find((w) => w.id === tidy.id)?.lifecycle === 'removed')
  check('W12-13 a clean, merged worktree is removed with Git; its branch is kept',
    !existsSync(tidy.cwd) && git(garden, 'branch', '--list', 'codex/tidy').includes('codex/tidy') && !git(garden, 'worktree', 'list').includes(tidy.cwd))
  await closeManage(page)
  await choose(page, /Main checkout/)
  await page.getByRole('tab', { name: 'Conversations', exact: true }).click()
  await page.locator('.card', { hasText: 'LINK tidy' }).click().catch(() => undefined)
  if (await page.locator('.file-link[data-path="notes.txt"]').count() === 0) {
    // The conversation lists under Tidy only; open it directly as a notification would.
    await page.evaluate((id) => { window.history.replaceState(null, '', `/?thread=${id}`) }, tidyThread)
    await page.reload()
  }
  await page.locator('.file-link[data-path="notes.txt"]').first().click()
  const toast = await until('missing notice', async () => ((await page.locator('.toast[role="alert"]').textContent()) ?? '').includes('is no longer there'))
  const filesOpened = await page.getByLabel('File contents').count()
  check('W12-13 the removed worktree\'s file link opens nothing: never the main checkout\'s copy', Boolean(toast) && filesOpened === 0, `${filesOpened} editor(s)`)
  await shot(page, '13-link-missing')

  // ======================= W12-09 / W12-10 / W12-11: merge back =======================
  const mergeRow = async (name: string): Promise<Locator> => {
    dialog = await manage(page)
    const r = row(dialog, name)
    await r.getByRole('button', { name: 'Merge into the main checkout…' }).click()
    await r.locator('.merge-back').waitFor()
    return r
  }
  step('W12-10 what blocks a merge')
  rmSync(join(rose.cwd, 'sketch.txt'))
  commit(rose.cwd, 'roses.txt', 'red\n', 'roses')
  writeFileSync(join(garden, 'draft.txt'), 'uncommitted in main\n')
  let r = await mergeRow('Rose bed')
  const dirtySays = (await r.locator('.merge-blocked').first().textContent()) ?? ''
  check('W12-10 uncommitted files in the main checkout block the merge, in words', /main checkout has uncommitted changes or untracked files/.test(dirtySays), dirtySays)
  check('W12-10 and Cockpit stashes nothing', readFileSync(join(garden, 'draft.txt'), 'utf8') === 'uncommitted in main\n' && git(garden, 'stash', 'list') === '')
  await shot(page, '10-blocked-dirty')
  rmSync(join(garden, 'draft.txt'))
  const elsewhere = join(root, 'main-elsewhere')
  git(garden, 'worktree', 'add', '-q', '-f', elsewhere, 'main')
  await r.getByRole('button', { name: 'Check again' }).click()
  const elsewhereSays = await until('elsewhere blocker', async () => { const t = (await r.locator('.merge-blocked').first().textContent()) ?? ''; return /also checked out at/.test(t) && t })
  check('W12-10 the target branch checked out elsewhere blocks the merge', Boolean(elsewhereSays), String(elsewhereSays))
  git(garden, 'worktree', 'remove', elsewhere)
  await closeManage(page)

  step('W12-09 fast-forward, then a stale approval, then a merge commit')
  r = await mergeRow('Rose bed')
  const ffSays = (await r.locator('.merge-note').first().textContent()) ?? ''
  check('W12-09 the preview names source, target, commits and the fast-forward', /codex\/rose-bed into main \(main checkout\): 1 commit, 1 file\. Fast-forward/.test(ffSays), ffSays)
  await r.getByRole('button', { name: 'Merge with Git' }).click()
  await r.getByText(/Merged into main/).waitFor()
  check('W12-09 fast-forward: main is at the worktree\'s commit; nothing pushed, worktree kept',
    git(garden, 'rev-parse', 'HEAD') === git(rose.cwd, 'rev-parse', 'HEAD') && existsSync(rose.cwd) && git(garden, 'branch', '--list', 'codex/rose-bed').includes('codex/rose-bed'))
  await closeManage(page)
  commit(rose.cwd, 'roses.txt', 'red\nwhite\n', 'more roses')
  r = await mergeRow('Rose bed')
  const moved = commit(garden, 'pond.txt', 'koi\n', 'main moved after the check')
  await r.getByRole('button', { name: 'Merge with Git' }).click()
  const staleSays = await until('stale', async () => { const t = (await r.locator('.modal-error').textContent()) ?? ''; return /changed after you checked/.test(t) && t })
  check('W12-09 an approval made before main moved is refused; nothing merged', Boolean(staleSays) && git(garden, 'rev-parse', 'HEAD') === moved, String(staleSays))
  await r.getByRole('button', { name: 'Check again' }).click()
  await r.getByText(/A merge commit joins both histories/).waitFor()
  await r.getByRole('button', { name: 'Merge with Git' }).click()
  await r.getByText(/Merged into main/).waitFor()
  check('W12-09 divergent histories get an explicit merge commit', git(garden, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3 && git(garden, 'log', '-1', '--format=%s') === 'Merge codex/rose-bed into main')
  await shot(page, '09-merged')
  await closeManage(page)

  step('W12-11 conflict → Continue')
  commit(rose.cwd, 'beds.txt', 'roses\nlilies\n', 'rose bed edits beds')
  commit(garden, 'beds.txt', 'roses\ndaisies\n', 'main edits beds')
  r = await mergeRow('Rose bed')
  await r.getByRole('button', { name: 'Merge with Git' }).click()
  await r.getByText(/conflicts in 1 file/).waitFor()
  check('W12-11 the exact conflicted path is shown', (await r.locator('.merge-files code').allTextContents()).join() === 'beds.txt')
  await shot(page, '11-conflict')
  await r.getByRole('button', { name: 'Continue' }).click()
  const stillSays = await until('still conflicted', async () => { const t = (await r.locator('.modal-error').textContent()) ?? ''; return /Still conflicted: beds.txt/.test(t) && t })
  check('W12-11 Continue waits for the resolution', Boolean(stillSays))
  writeFileSync(join(garden, 'beds.txt'), 'roses\nlilies\ndaisies\n')
  git(garden, 'add', 'beds.txt')
  await r.getByRole('button', { name: 'Continue' }).click()
  await r.getByText(/Merged into main/).waitFor()
  check('W12-11 Continue commits the resolved merge', readFileSync(join(garden, 'beds.txt'), 'utf8') === 'roses\nlilies\ndaisies\n' && git(garden, 'status', '--porcelain') === '')
  await closeManage(page)

  step('W12-11 conflict → Abort')
  commit(rose.cwd, 'beds.txt', 'roses\nirises\n', 'rose bed again')
  const beforeAbort = commit(garden, 'beds.txt', 'roses\nasters\n', 'main again')
  r = await mergeRow('Rose bed')
  await r.getByRole('button', { name: 'Merge with Git' }).click()
  await r.getByText(/conflicts in 1 file/).waitFor()
  await r.getByRole('button', { name: 'Abort merge' }).click()
  await r.getByText(/Merge aborted/).waitFor()
  check('W12-11 Abort puts the main checkout back exactly', git(garden, 'rev-parse', 'HEAD') === beforeAbort && git(garden, 'status', '--porcelain') === '')
  await closeManage(page)

  step('W12-11 a real crash after Git started the merge')
  await app.close()
  app = await launch({ COCKPIT_PROOF_MERGE_CRASH: '1' })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('button', { name: /^Workspace:/ }).first().waitFor()
  const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()))
  r = await mergeRow('Rose bed')
  await r.getByRole('button', { name: 'Merge with Git' }).click({ timeout: 5000 }).catch(() => undefined)
  const died = await Promise.race([exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 20_000))])
  app = undefined
  const mergeHead = existsSync(join(garden, '.git', 'MERGE_HEAD'))
  check('W12-11 the app died after Git stopped on the conflict, before recording it', died && mergeHead)
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('button', { name: /^Workspace:/ }).first().waitFor()
  r = await mergeRow('Rose bed')
  const recovered = await until('recovered conflict', async () => (await r.getByText(/conflicts in 1 file/).count()) === 1)
  check('W12-11 reopening shows the recorded conflict, with Continue and Abort', Boolean(recovered) && await r.getByRole('button', { name: 'Abort merge' }).count() === 1)
  await shot(page, '11-recovered')
  await r.getByRole('button', { name: 'Abort merge' }).click()
  await r.getByText(/Merge aborted/).waitFor()
  check('W12-11 nothing was merged twice: main is back where it was', git(garden, 'rev-parse', 'HEAD') === beforeAbort && !existsSync(join(garden, '.git', 'MERGE_HEAD')))
  await closeManage(page)

  // ======================= W12-14: Git changed outside Cockpit; restart =======================
  step('W12-14 Pond moved and Lilies deleted outside Cockpit, then Quit and reopen')
  rmSync(join(pond.cwd, 'build'), { recursive: true, force: true })
  const pondMoved = join(root, 'pond-moved-by-hand')
  git(garden, 'worktree', 'move', pond.cwd, pondMoved)
  rmSync(lilies.cwd, { recursive: true, force: true })
  const gitBefore = git(garden, 'worktree', 'list', '--porcelain')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('button', { name: /^Workspace:/ }).first().waitFor()
  const health = (await list()).health
  check('W12-14 after restart the registry reports what Git has: Pond moved, Lilies missing',
    health[pond.id]?.state === 'moved' && health[lilies.id]?.state === 'missing', JSON.stringify(health))
  dialog = await manage(page)
  check('W12-14 Manage worktrees says so', (await row(dialog, 'Pond').locator('.worktree-state').allTextContents()).join() === 'Moved'
    && (await row(dialog, 'Lilies').locator('.worktree-state').allTextContents()).join() === 'Folder missing')
  await shot(page, '14-reconciled')
  await row(dialog, 'Lilies').getByRole('button', { name: 'Forget' }).click()
  await until('lilies forgotten', async () => (await list()).workspaces.find((w) => w.id === lilies.id)?.lifecycle === 'removed')
  check('W12-14 nothing was pruned or recreated; Forget left Git\'s records alone',
    git(garden, 'worktree', 'list', '--porcelain') === gitBefore && !existsSync(lilies.cwd) && !existsSync(pond.cwd) && existsSync(pondMoved))
  await closeManage(page)
} catch (error) {
  const window = app ? await app.firstWindow().catch(() => undefined) : undefined
  if (window) await shot(window, 'failed').catch(() => undefined)
  check('the proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app?.close().catch(() => undefined)
}
await new Promise((r) => setTimeout(r, 1500))
check('Quit ends every agent and process Cockpit started', sleepers().filter((p) => !before.includes(p)).length === 0)
console.log(`  state kept in ${root}`)
finish('proof:wave-12-lifecycle')
