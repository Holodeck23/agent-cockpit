// Packaged gate for wave 12 part 1 (order 17, worktrees): W12-05 – W12-08 on the PACKAGED app, with
// a stand-in agent (scripts/fixtures/wave12-agent) whose replies say the folder it ran in, the
// session it was given, whether that was a resume, and which MARK-* words reached it.
//
//   W12-06  the app really dies between Git creating a worktree and Cockpit registering it
//           (COCKPIT_PROOF_WORKTREE_CRASH), then reopens: Recover once, no duplicate, nothing deleted.
//   W12-05  create from a chosen commit with a dirty main checkout; bad ref, branch collision and an
//           unborn repository are refused and leave nothing behind.
//   W12-07  one conversation main → worktree → main: native sessions, handoff and catch-up, labels,
//           and each workspace's own draft text and image chips kept.
//   W12-08  files, pins, documents label, stale answers, MCP processes, results, browser and file IPC,
//           workflows: each resolves to the intended workspace.
//
// Usage: npm run package:proof, wait a minute (XProtect scans fresh binaries), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-12
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject } from './lib/ui.ts'

const { check, finish } = checker()
const FIX = join(ROOT, 'scripts/fixtures')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

// ---------- fixtures: a repository with two commits and a dirty main checkout, and an unborn one ----------
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-wave12-proof-')))
const state = join(root, 'state'), garden = join(root, 'garden'), seedling = join(root, 'seedling')
for (const dir of [state, garden, seedling]) mkdirSync(dir, { recursive: true })
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Gardener', GIT_AUTHOR_EMAIL: 'g@example.invalid', GIT_COMMITTER_NAME: 'Gardener', GIT_COMMITTER_EMAIL: 'g@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
git(garden, 'init', '-q', '-b', 'main')
writeFileSync(join(garden, 'README.md'), '# Garden v1\n')
writeFileSync(join(garden, 'beds.txt'), 'roses\n')
git(garden, 'add', '.'); git(garden, 'commit', '-q', '-m', 'v1')
const commitA = git(garden, 'rev-parse', 'HEAD')
writeFileSync(join(garden, 'README.md'), '# Garden v2\n')
git(garden, 'commit', '-q', '-am', 'v2')
const DIRTY = '# Garden v2\nAn uncommitted edit in the main checkout.\n'
writeFileSync(join(garden, 'README.md'), DIRTY)
writeFileSync(join(garden, 'scratch.txt'), 'untracked in the main checkout\n')
git(seedling, 'init', '-q', '-b', 'main')
mkdirSync(PROOF_DIR, { recursive: true })

// ---------- helpers ----------
const step = (label: string): void => console.log(`  · ${label}`)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave12-${name}.png`) })
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

interface Workspace { id: string; kind: 'primary' | 'worktree'; cwd: string; name?: string; branch?: string; lifecycle: string }
interface Pending { id: string; name: string }
interface Project { path: string; projectId?: string; workspaceId?: string }
interface Meta { id: string; projectPath: string; workspaceId?: string; sessionId?: string; bindings?: Record<string, unknown> }
interface Detail { meta: Meta; status: string; events: Array<{ ts: string; event: { kind: string; text?: string; runId?: string; images?: unknown[] } }> }
interface Proc { id: string; name: string; cwd: string; workspaceId?: string; status: string; projectPath: string }

const projectOf = async (page: Page, path: string): Promise<Project> => (await get<Project[]>(page, '/api/projects')).find((p) => p.path === path)!
const workspacesOf = async (page: Page, projectId: string) => get<{ workspaces: Workspace[]; pending: Pending[] }>(page, `/api/projects/${projectId}/workspaces`)
const gitWorktrees = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
const siblings = (): string[] => readdirSync(root).filter((n) => n.startsWith('garden-worktree-')).sort()
const detail = (page: Page, id: string) => get<Detail>(page, `/api/threads/${id}/events`)
const replies = async (page: Page, id: string): Promise<string[]> => (await detail(page, id)).events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '')
/** Waits for the conversation's reply number `n` and for it to be idle again. */
async function reply(page: Page, id: string, n: number): Promise<string> {
  return (await until(`reply ${n}`, async () => {
    const d = await detail(page, id)
    const texts = d.events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '')
    return texts.length >= n && d.status !== 'working' && d.status !== 'starting' ? texts[n - 1] : undefined
  }, 30_000)) ?? ''
}
const field = (text: string, name: string): string => new RegExp(`${name}=(\\S*)`).exec(text)?.[1] ?? ''
const saw = (text: string): string[] => /saw=\[([^\]]*)\]/.exec(text)?.[1]?.split(' ').filter(Boolean) ?? []

/** The selector under the conversation list, driven the way a person does. */
async function choose(page: Page, label: RegExp): Promise<void> {
  await page.getByRole('button', { name: /^Workspace:/ }).click()
  const list = page.getByRole('listbox', { name: 'Workspaces' })
  await list.waitFor()
  await list.getByRole('option', { name: label }).click()
  await list.waitFor({ state: 'detached' })
}
async function openNewWorktree(page: Page) {
  await page.getByRole('button', { name: /^Workspace:/ }).click()
  await page.getByRole('button', { name: /New worktree/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New worktree' })
  await dialog.waitFor()
  return dialog
}
/** Pastes an image file into the message box, as a person pasting a screenshot. */
async function pasteImage(page: Page, name: string): Promise<void> {
  await messageBox(page).focus()
  await page.evaluate(([n, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], n, { type: 'image/png' }))
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, [name, PNG.toString('base64')] as const)
  await page.locator('.image-chip', { hasText: name }).waitFor()
}
const chips = async (page: Page): Promise<string[]> => (await page.locator('.image-chip span').allTextContents()).sort()
const section = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click()

const launch = (extra: Record<string, string> = {}): Promise<ElectronApplication> => launchPackagedApp({
  COCKPIT_HOME: state, COCKPIT_AGENT_PATH: join(FIX, 'wave12-agent'), ...extra,
})

let app: ElectronApplication | undefined
const sleepers = (): string[] => {
  try { return execFileSync('/usr/bin/pgrep', ['-f', '^sleep 600$'], { encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
}
const sleepersBefore = sleepers()
try {
  // ======================= W12-06: a real crash between Git and the registry =======================
  step('W12-06 launch with the crash point armed')
  app = await launch({ COCKPIT_PROOF_WORKTREE_CRASH: '1' })
  let page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, garden, 'Garden')
  const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()))
  const crashDialog = await openNewWorktree(page)
  await crashDialog.getByLabel('Worktree name').fill('Hedge trimming')
  // The window goes with the app, so the click may never be acknowledged.
  await crashDialog.getByRole('button', { name: 'Create' }).click({ timeout: 5000 }).catch(() => undefined)
  const died = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))])
  app = undefined
  const hedgePath = siblings().map((n) => join(root, n))[0] ?? ''
  check('W12-06 the app died after Git created the worktree and before Cockpit registered it',
    died && Boolean(hedgePath) && gitWorktrees(garden).includes(hedgePath), `${died ? 'exited' : 'still running'}; git: ${gitWorktrees(garden).length - 1} worktree(s)`)
  // Work someone did in the orphan before reopening: recovery must keep it.
  if (hedgePath) writeFileSync(join(hedgePath, 'unique-note.txt'), 'written after the crash\n')

  step('W12-06 reopen')
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('tab', { selected: true }).first().waitFor()
  const pendingList = page.getByRole('list', { name: 'Interrupted worktrees' })
  await pendingList.waitFor()
  const pendingRow = pendingList.locator('li', { hasText: 'Hedge trimming' })
  check('W12-06 reopening offers repair of the interrupted create, naming what Git has',
    await pendingRow.getByText(/Git has it/).count() === 1 && await pendingRow.getByRole('button', { name: 'Recover' }).count() === 1)
  await shot(page, '06-interrupted')
  await pendingRow.getByRole('button', { name: 'Recover' }).click()
  await pendingList.waitFor({ state: 'detached' })
  const gardenProject = await projectOf(page, garden)
  const pid = gardenProject.projectId!
  let listed = await workspacesOf(page, pid)
  const hedge = listed.workspaces.filter((w) => w.kind === 'worktree' && w.name === 'Hedge trimming')
  check('W12-06 Recover registers the one worktree Git made: no duplicate create, unique work kept',
    hedge.length === 1 && hedge[0]!.cwd === hedgePath && hedge[0]!.lifecycle === 'active' && gitWorktrees(garden).length === 2 && siblings().length === 1
      && existsSync(join(hedgePath, 'unique-note.txt')) && listed.pending.length === 0,
    `registered ${hedge.length}, git ${gitWorktrees(garden).length}, folders ${siblings().length}`)
  check('W12-06 the recovered worktree is selected', await page.getByRole('button', { name: /^Workspace: Hedge trimming/ }).count() === 1)

  // ======================= W12-05: create from a chosen commit; refusals leave nothing =======================
  step('W12-05 create from commit v1 with a dirty main checkout')
  await choose(page, /Main checkout/)
  let dialog = await openNewWorktree(page)
  const uncommitted = await dialog.getByText(/uncommitted files? in the main checkout will not be copied/).textContent({ timeout: 10_000 })
  check('W12-05 the dialog says the main checkout\'s uncommitted files are not copied', /2 uncommitted files/.test(uncommitted ?? ''), uncommitted ?? '')
  await dialog.getByLabel('Worktree name').fill('Rose bed')
  await dialog.getByLabel('Base').fill(commitA.slice(0, 10))
  await shot(page, '05-dialog')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await dialog.waitFor({ state: 'detached' })
  listed = await workspacesOf(page, pid)
  const rose = listed.workspaces.find((w) => w.name === 'Rose bed')!
  const primary = listed.workspaces.find((w) => w.kind === 'primary')!
  check('W12-05 the worktree starts at exactly the chosen commit on its own branch',
    Boolean(rose) && git(rose.cwd, 'rev-parse', 'HEAD') === commitA && rose.branch === 'codex/rose-bed' && git(rose.cwd, 'branch', '--show-current') === 'codex/rose-bed')
  check('W12-05 dirty files stay in the main checkout and are not copied',
    readFileSync(join(rose.cwd, 'README.md'), 'utf8') === '# Garden v1\n' && !existsSync(join(rose.cwd, 'scratch.txt'))
      && readFileSync(join(garden, 'README.md'), 'utf8') === DIRTY && existsSync(join(garden, 'scratch.txt')))
  check('W12-05 the new worktree is selected and labelled with its branch',
    await page.getByRole('button', { name: /^Workspace: Rose bed/ }).count() === 1)

  const nothingNew = async (label: string, before: { git: number; folders: string[]; registered: number }): Promise<boolean> => {
    const after = await workspacesOf(page, pid)
    const same = gitWorktrees(garden).length === before.git && siblings().join() === before.folders.join() && after.workspaces.length === before.registered && after.pending.length === 0
    if (!same) console.log(`  (${label}: git ${gitWorktrees(garden).length}/${before.git}, folders ${siblings().length}/${before.folders.length}, registered ${after.workspaces.length}/${before.registered}, pending ${after.pending.length})`)
    return same
  }
  const snapshot = async () => ({ git: gitWorktrees(garden).length, folders: siblings(), registered: (await workspacesOf(page, pid)).workspaces.length })

  step('W12-05 refusals')
  await choose(page, /Main checkout/)
  for (const [label, base, branch, expected] of [
    ['an unknown ref', 'no-such-ref', '', /does not know a commit called "no-such-ref"/],
    ['a ref that looks like an option', '--output=leak.txt', '', /does not know a commit called "--output=leak\.txt"/],
    ['a branch checked out in another worktree', '', 'codex/rose-bed', /already exists|checked out/i],
  ] as const) {
    const before = await snapshot()
    dialog = await openNewWorktree(page)
    await dialog.getByLabel('Worktree name').fill('Clash')
    if (base) await dialog.getByLabel('Base').fill(base)
    if (branch) await dialog.getByLabel('Branch').fill(branch)
    await dialog.getByRole('button', { name: 'Create' }).click()
    const alert = dialog.locator('.modal-error')
    await alert.waitFor()
    const said = (await alert.textContent()) ?? ''
    if (label === 'a branch checked out in another worktree') await shot(page, '05-refused-collision')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    check(`W12-05 ${label} is refused in words and leaves no hidden duplicate`, expected.test(said) && await nothingNew(label, before) && !existsSync(join(garden, 'leak.txt')), said.slice(0, 120))
  }

  step('W12-05 unborn repository')
  await openProject(page, seedling, 'Seedling')
  dialog = await openNewWorktree(page)
  const unbornSaid = (await dialog.locator('.modal-error').textContent()) ?? ''
  const createDisabled = await dialog.getByRole('button', { name: 'Create' }).isDisabled()
  await dialog.getByLabel('Worktree name').fill('First bed')
  check('W12-05 an unborn repository is refused before anything is made',
    /commit/i.test(unbornSaid) && createDisabled && await dialog.getByRole('button', { name: 'Create' }).isDisabled() && gitWorktrees(seedling).length === 1 && readdirSync(root).filter((n) => n.startsWith('seedling-worktree-')).length === 0,
    unbornSaid.slice(0, 120))
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await openProject(page, garden, 'Garden')

  // ======================= W12-07: one conversation, main → worktree → main =======================
  step('W12-07 a conversation in the main checkout')
  await choose(page, /Main checkout/)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill('MARK-P1 plan the beds')
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: /MARK-P1/ }).waitFor()
  const threadId = await until('conversation id', async () => (await get<Array<{ meta: Meta }>>(page, '/api/threads')).find((t) => t.meta.projectPath === garden)?.meta.id)
  if (!threadId) throw new Error('no conversation')
  const r1 = await reply(page, threadId, 1)
  const s1 = field(r1, 'session')
  check('W12-07 turn 1 runs in the main checkout, new session', field(r1, 'cwd') === garden && field(r1, 'resumed') === '0' && Boolean(s1), r1)

  step('W12-07 a main-checkout draft with an image, left unsent')
  await messageBox(page).fill('MARK-P2 back home')
  await pasteImage(page, 'home.png')

  step('W12-07 choose Rose bed with the conversation open')
  await choose(page, /Rose bed/)
  const stillOpen = await page.getByRole('heading', { level: 1, name: /MARK-P1/ }).count() === 1
  const note = (await page.locator('.workspace-note').textContent().catch(() => '')) ?? ''
  check('W12-07 choosing a worktree keeps the conversation open and says where the next message goes',
    stillOpen && /continues this conversation in Rose bed\. It last worked in the main checkout\./.test(note), note)
  check('W12-07 the worktree has its own draft: the main checkout\'s text and image are not here',
    await messageBox(page).inputValue() === '' && (await chips(page)).length === 0)
  await messageBox(page).fill('MARK-W1 continue in the rose bed')
  await pasteImage(page, 'rose.png')
  await shot(page, '07-move-note')
  await messageBox(page).press('Enter')
  const r2 = await reply(page, threadId, 2)
  const s2 = field(r2, 'session')
  check('W12-07 turn 2 runs in Rose bed in its own new session, handed the conversation so far',
    field(r2, 'cwd') === rose.cwd && field(r2, 'resumed') === '0' && Boolean(s2) && s2 !== s1 && saw(r2).includes('MARK-P1') && saw(r2).includes('MARK-W1'), r2)
  check('W12-07 the header names the workspace the conversation works in now', (await page.locator('.workspace-chip').textContent())?.includes('Rose bed') === true)

  step('W12-07 back to the main checkout')
  await choose(page, /Main checkout/)
  check('W12-07 the main checkout\'s draft text and image chip are as they were left',
    await messageBox(page).inputValue() === 'MARK-P2 back home' && (await chips(page)).join() === 'home.png', `${await messageBox(page).inputValue()} | ${(await chips(page)).join()}`)
  await messageBox(page).press('Enter')
  const r3 = await reply(page, threadId, 3)
  check('W12-07 turn 3 resumes the main checkout\'s own session with only what happened since (Rose bed\'s turn)',
    field(r3, 'cwd') === garden && field(r3, 'resumed') === '1' && field(r3, 'session') === s1 && saw(r3).includes('MARK-W1') && saw(r3).includes('MARK-P2') && !saw(r3).includes('MARK-P1'), r3)
  await messageBox(page).fill('a plain follow-up')
  await messageBox(page).press('Enter')
  const r4 = await reply(page, threadId, 4)
  check('W12-07 the catch-up is not sent twice', field(r4, 'session') === s1 && saw(r4).length === 0, r4)

  await choose(page, /Rose bed/)
  check('W12-07 Rose bed\'s draft went with its send; the main checkout\'s send did not touch it',
    await messageBox(page).inputValue() === '' && (await chips(page)).length === 0, (await chips(page)).join())
  const d = await detail(page, threadId)
  const userImages = d.events.filter((e) => e.event.kind === 'user_text').map((e) => e.event.images?.length ?? 0)
  const allThreads = (await get<Array<{ meta: Meta }>>(page, '/api/threads')).filter((t) => t.meta.projectPath === garden)
  check('W12-07 one conversation, one transcript; each sent image went with its own message',
    allThreads.length === 1 && userImages.join() === '0,1,1,0' && d.events.filter((e) => e.event.kind === 'workspace_changed').length === 2, `threads ${allThreads.length}, images ${userImages.join()}`)
  check('W12-07 the conversation is listed under both workspaces it ran in',
    await page.locator('.card', { hasText: 'MARK-P1' }).count() === 1)
  await shot(page, '07-rose-bed')

  // ======================= W12-08: everything resolves to the intended workspace =======================
  step('W12-08 files and documents')
  await section(page, 'Files')
  await page.getByRole('tab', { name: 'Project files' }).click()
  const kicker = (await page.locator('.file-list .workflow-kicker').textContent()) ?? ''
  await page.locator('.file-row').filter({ hasText: 'README.md' }).click()
  const fileText = page.getByLabel('File contents')
  await until('worktree README', async () => (await fileText.inputValue()) === '# Garden v1\n')
  check('W12-08 Files in Rose bed reads the worktree\'s own file and says which workspace', (await fileText.inputValue()) === '# Garden v1\n' && kicker === 'Garden · Rose bed', kicker)
  await page.getByRole('tab', { name: 'Your documents' }).click()
  const docNote = (await page.locator('.file-space-note').textContent()) ?? ''
  check('W12-08 Your documents are labelled as shared by every workspace', /Shared by every workspace of Garden/.test(docNote), docNote)
  await shot(page, '08-documents-shared')
  await page.getByRole('tab', { name: 'Project files' }).click()

  step('W12-08 pins')
  await call(page, 'POST', '/api/projects/pins', { path: garden, files: ['README.md'] })
  await page.reload()
  await section(page, 'Files')
  await page.locator('.subnav-pin', { hasText: 'README.md' }).click()
  const pinnedRose = await until('pinned README in Rose bed', async () => (await fileText.inputValue()) === '# Garden v1\n' && 'v1')
  check('W12-08 a pinned file opens in the selected worktree, never the main checkout\'s copy', pinnedRose === 'v1', await fileText.inputValue())

  step('W12-08 a slow answer for the old selection does not replace the new view')
  let delayed = 0
  await page.route(/\/api\/files\/read\?.*workspaceId=/, async (route) => { delayed += 1; await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => undefined) })
  await page.reload()
  await section(page, 'Files')
  await page.locator('.file-row').filter({ hasText: 'README.md' }).click()
  await choose(page, /Main checkout/)
  await page.locator('.file-row').filter({ hasText: 'README.md' }).click()
  await until('main README', async () => (await fileText.inputValue()) === DIRTY)
  await new Promise((r) => setTimeout(r, 3500))
  check('W12-08 the late worktree answer was dropped; the main checkout\'s file stays shown', delayed >= 1 && (await fileText.inputValue()) === DIRTY, `${delayed} delayed`)
  await page.unroute(/\/api\/files\/read\?.*workspaceId=/)

  step('W12-08 an MCP process started by the agent in Rose bed')
  await choose(page, /Rose bed/)
  await section(page, 'Conversations')
  await page.locator('.card', { hasText: 'MARK-P1' }).click()
  await messageBox(page).fill('START-PROC please')
  await messageBox(page).press('Enter')
  const approval = page.locator('.approval.open')
  await approval.waitFor({ timeout: 30_000 })
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  const r5 = await reply(page, threadId, 5)
  const sleeper = await until('wt-sleeper', async () => (await get<Proc[]>(page, '/api/processes')).find((p) => p.name === 'wt-sleeper' && p.status === 'running'))
  check('W12-08 the agent\'s MCP grant starts the process in the worktree folder, owned by that workspace',
    /process=20[01]/.test(r5) && sleeper?.cwd === rose.cwd && sleeper?.workspaceId === rose.id, `${r5} | ${sleeper?.cwd}`)
  await section(page, 'Processes')
  const inRose = await page.locator('.process-row', { hasText: 'wt-sleeper' }).count()
  const processKicker = (await page.locator('.workflow-kicker').first().textContent()) ?? ''
  await choose(page, /Main checkout/)
  const inMain = await page.locator('.process-row', { hasText: 'wt-sleeper' }).count()
  check('W12-08 Processes lists it under Rose bed only', inRose === 1 && inMain === 0 && processKicker === 'Garden · Rose bed', `rose ${inRose}, main ${inMain}`)

  step('W12-08 a host check on the Rose bed run')
  const runId = [...(await detail(page, threadId)).events].reverse().find((e) => e.event.kind === 'user_text')?.event.runId ?? ''
  const started = await call(page, 'POST', `/api/runs/${encodeURIComponent(runId)}/checks`, {
    threadId, operationId: `proof-${Date.now()}`, definition: { command: 'pwd -P', criterion: { kind: 'output-includes', text: basename(rose.cwd) } },
  })
  const outcome = await until('check outcome', async () => {
    const view = await get<{ checks: Array<{ outcome?: string; definition: { command: string } }> }>(page, `/api/runs/${encodeURIComponent(runId)}/result?threadId=${threadId}`)
    return view.checks.find((c) => c.definition.command === 'pwd -P')?.outcome
  })
  check('W12-08 the check runs where the run ran (the worktree), whatever the window shows', started.status === 202 && outcome === 'passed', `${started.status} ${started.error ?? ''} ${outcome}`)

  step('W12-08 desktop file and browser IPC')
  const stranger = `${garden}-worktree-ffffff`
  mkdirSync(stranger, { recursive: true })
  const ipc = await page.evaluate(async ([g, r, s]) => {
    const bridge = (window as unknown as { cockpit: { browser: { clearData(p: string): Promise<string | undefined> }; fileAction(q: unknown): Promise<string | undefined> } }).cockpit
    return {
      clearRose: await bridge.browser.clearData(r!), clearMain: await bridge.browser.clearData(g!), clearStranger: await bridge.browser.clearData(s!),
      fileRose: await bridge.fileAction({ projectPath: r, space: 'project', path: 'README.md', action: 'inspect' }),
      fileStranger: await bridge.fileAction({ projectPath: s, space: 'project', path: 'README.md', action: 'inspect' }),
      docsRose: await bridge.fileAction({ projectPath: r, space: 'documents', path: 'x.md', action: 'inspect' }),
    }
  }, [garden, rose.cwd, stranger] as const)
  check('W12-08 the shell accepts the project and its registered worktree, refuses an unregistered lookalike',
    ipc.clearRose === undefined && ipc.clearMain === undefined && ipc.clearStranger !== undefined && ipc.fileRose === 'Unknown action' && ipc.fileStranger === 'Unknown project' && ipc.docsRose === 'Unknown project',
    JSON.stringify(ipc))

  step('W12-08 a workflow run while Rose bed is selected')
  await choose(page, /Rose bed/)
  const flow = await call<{ id: string }>(page, 'POST', '/api/workflows', { projectPath: garden, name: 'bed-check', prompt: 'workflow turn', settings: { agent: 'claude', permissionMode: 'manual', useHooks: false } })
  const ran = await call<Meta>(page, 'POST', `/api/workflows/${flow.data?.id}/run`, {})
  const flowReply = ran.data ? await reply(page, ran.data.id, 1) : ''
  check('W12-08 a workflow runs in the main checkout by explicit policy, not the window\'s selection',
    ran.data?.workspaceId === primary.id && field(flowReply, 'cwd') === garden, `${ran.status} ${ran.error ?? ''} ${flowReply}`)

  await shot(page, '08-end')
} catch (error) {
  check('the proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app?.close().catch(() => undefined)
}
// Quit leaves none of the processes it owned (the agent's wt-sleeper).
await new Promise((r) => setTimeout(r, 1500))
check('Quit ends the worktree process Cockpit started', sleepers().filter((p) => !sleepersBefore.includes(p)).length === 0)
console.log(`  state kept in ${root} (${dirname(state)})`)
finish('proof:wave-12 part 1')
