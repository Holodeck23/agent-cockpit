// Packaged gate for the combined order 16 + 17/18 scenarios, with stand-in CLIs only
// (scripts/fixtures/accounts-agent: signed in to whichever account its context holds; it logs each
// launch's context, account, handoff and folder). No provider usage, a throwaway HOME.
//
//   CROSS-04  Project P uses account A in worktree A while project Q runs on its own. P refuses an
//             account change while it works; afterwards P on account B continues in worktree B; Q
//             is untouched; P's earlier history stays attributed to A.
//   CROSS-09  A real v0.1.5 installation (release/v0.1.5) writes its state; this build opens it,
//             makes an account and a worktree, fails an operation, Quits and reopens: the original
//             state is intact, recovery is precise, and no process is left behind.
//
// Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:cross-accounts-worktrees
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { checker, launchPackagedApp, LAUNCHD_PATH, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-cross-acct-wt-')))
const home = join(root, 'home'), log = join(root, 'launches.log')
for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(home, '.claude', '.fixture-identity'), 'alice@example.com 10\n')
writeFileSync(join(home, '.codex', '.fixture-identity'), 'alice@example.com 20\n')
mkdirSync(PROOF_DIR, { recursive: true })
const ident = { GIT_AUTHOR_NAME: 'Gardener', GIT_AUTHOR_EMAIL: 'g@example.invalid', GIT_COMMITTER_NAME: 'Gardener', GIT_COMMITTER_EMAIL: 'g@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } }).trim()
const repo = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}
// The v0.1.5 proof build (same code as the release, with the inspect switch Playwright needs).
const V015 = join(ROOT, 'release/v0.1.5/proof/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit')

// ---------- helpers ----------
const step = (label: string): void => console.log(`  · ${label}`)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `cross-${name}.png`) })
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
interface Ev { event: { kind: string; text?: string; runId?: string; account?: { id: string }; to?: { id?: string } }; workspaceId?: string }
const events = async (page: Page, id: string): Promise<Ev[]> => (await get<{ events: Ev[] }>(page, `/api/threads/${id}/events`)).events
const replies = async (page: Page, id: string): Promise<string[]> => (await events(page, id)).filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '')
const status = async (page: Page, id: string): Promise<string> => (await get<{ status: string }>(page, `/api/threads/${id}/events`)).status
const launches = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
const projectId = async (page: Page, path: string): Promise<string> => (await get<Array<{ path: string; projectId: string }>>(page, '/api/projects')).find((p) => p.path === path)!.projectId
const fixtureProcs = (): string[] => { try { return execFileSync('/usr/bin/pgrep', ['-f', 'fixtures/accounts-agent/claude'], { encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] } }
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Agent settings' })
const accountBox = (page: Page): Locator => picker(page).getByRole('combobox', { name: 'Account' })
async function addAccount(page: Page, label: string, code: string): Promise<string> {
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await accountBox(page).waitFor()
  await accountBox(page).selectOption('__add')
  await picker(page).getByLabel('Account name').fill(label)
  await picker(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await picker(page).getByLabel('Sign-in code').fill(code)
  await picker(page).getByRole('button', { name: 'Continue', exact: true }).click()
  // Short timeouts: a locator that is not there would otherwise be waited on for the page's default.
  const said = await until('sign-in outcome', async () => {
    const chosen = await accountBox(page).evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? '', undefined, { timeout: 1000 }).catch(() => '')
    if (chosen.startsWith(label)) return `chosen:${chosen}`
    const alerts = picker(page).getByRole('alert')
    return (await alerts.count()) > 0 ? `alert:${(await alerts.first().textContent({ timeout: 1000 }).catch(() => '')) ?? ''}` : undefined
  })
  await page.keyboard.press('Escape')
  return said ?? ''
}

const accountsEnv = (state: string) => ({
  HOME: home, SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'), COCKPIT_HOME: state,
  COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/accounts-agent'), COCKPIT_PROOF_ACCOUNT_LOG: log,
})

let app: ElectronApplication | undefined
try {
  // ======================= CROSS-04 =======================
  step('CROSS-04 P on account A in worktree A, Q on its own')
  const stateA = join(root, 'state-cross04')
  const P = repo('plot'), Q = repo('quarry')
  app = await launchPackagedApp(accountsEnv(stateA))
  let page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, Q, 'Quarry')
  await openProject(page, P, 'Plot')
  const pid = await projectId(page, P), qid = await projectId(page, Q)
  // Work B is added (and chosen) here, then P goes back to the CLI default: account A.
  const added = await addAccount(page, 'Work B', 'ok:bob@example.com')
  const workB = (await get<{ selection: { claude: string } }>(page, `/api/projects/${pid}/accounts`)).selection.claude
  await call(page, 'POST', `/api/projects/${pid}/accounts/claude`, { accountId: 'default-claude' })
  check('CROSS-04 a second account is signed in through the CLI\'s own flow', added.startsWith('chosen:Work B') && workB !== 'default-claude', added)
  const make = async (name: string) => (await call<{ workspace: { id: string; cwd: string } }>(page, 'POST', `/api/projects/${pid}/workspaces`, { name })).data!.workspace
  const bedA = await make('Bed A'), bedB = await make('Bed B')
  const settings = { agent: 'claude', permissionMode: 'manual', useHooks: false }
  const pThread = (await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: P, workspaceId: bedA.id, text: 'HOLD plot work in bed A', settings })).data!.id
  const qThread = (await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: Q, text: 'HOLD quarry work', settings })).data!.id
  await until('P working', async () => (await status(page, pThread)) === 'working')
  const refused = await call(page, 'POST', `/api/projects/${pid}/accounts/claude`, { accountId: workB })
  check('CROSS-04 P refuses the account change while its binding is busy', refused.status === 409 && (await get<{ selection: { claude: string } }>(page, `/api/projects/${pid}/accounts`)).selection.claude === 'default-claude', refused.error ?? '')
  check('CROSS-04 Q keeps working meanwhile', (await status(page, qThread)) === 'working')
  await until('P finished', async () => (await replies(page, pThread)).includes('Done as alice@example.com'), 30_000)
  const changed = await call(page, 'POST', `/api/projects/${pid}/accounts/claude`, { accountId: workB })
  check('CROSS-04 once P is idle, account B is selected for it', changed.status === 200, changed.error ?? '')
  await call(page, 'POST', `/api/threads/${pThread}/messages`, { text: 'continue in bed B', workspaceId: bedB.id })
  const asB = await until('P as B', async () => (await replies(page, pThread)).includes('Done as bob@example.com') && true, 30_000)
  const pLaunches = launches().filter((l) => l.includes(`cwd=${bedA.cwd}`) || l.includes(`cwd=${bedB.cwd}`))
  const lastP = pLaunches.at(-1) ?? ''
  check('CROSS-04 P\'s next run is account B, in worktree B, as a fresh session with the conversation as handoff',
    Boolean(asB) && lastP.includes('account=bob@example.com') && lastP.includes(`cwd=${bedB.cwd}`) && lastP.includes('resume=-') && lastP.includes('handoff=yes'), lastP)
  check('CROSS-04 P\'s first run was account A in worktree A', (pLaunches[0] ?? '').includes('account=alice@example.com') && (pLaunches[0] ?? '').includes(`cwd=${bedA.cwd}`), pLaunches[0] ?? '')
  await until('Q finished', async () => (await replies(page, qThread)).length > 0, 30_000)
  const qLaunches = launches().filter((l) => l.includes(`cwd=${Q}`))
  check('CROSS-04 Q is untouched: its runs stayed on the CLI default and its selection never changed',
    qLaunches.length > 0 && qLaunches.every((l) => l.startsWith('claude ctx=default account=alice@example.com')) && (await get<{ selection: { claude: string } }>(page, `/api/projects/${qid}/accounts`)).selection.claude === 'default-claude')
  const pEvents = await events(page, pThread)
  const boundaries = pEvents.filter((e) => e.event.kind === 'session_boundary')
  check('CROSS-04 P\'s history stays attributed: the first session was account A in worktree A, the change is recorded',
    boundaries[0]?.event.account?.id === 'default-claude' && boundaries[0]?.workspaceId === bedA.id && boundaries.at(-1)?.event.account?.id === workB
      && pEvents.some((e) => e.event.kind === 'account_changed') && pEvents.some((e) => e.event.kind === 'assistant_text' && e.event.text === 'Done as alice@example.com'))
  // Evidence too: each run's result card names the account its session ran on, after the switch.
  const pRuns = pEvents.filter((e) => e.event.kind === 'user_text' && e.event.runId).map((e) => e.event.runId as string)
  const accountOfRun = async (runId: string) => (await get<{ identity: { account: string | { id: string } } }>(page, `/api/runs/${runId}/result?threadId=${pThread}`)).identity.account
  const firstAccount = await accountOfRun(pRuns[0]!), lastAccount = await accountOfRun(pRuns.at(-1)!)
  check('CROSS-04 P\'s results stay with their account: the first run\'s is the CLI default (A), the last run\'s is Work B',
    firstAccount === 'default' && typeof lastAccount === 'object' && lastAccount.id === workB, JSON.stringify([firstAccount, lastAccount]))
  await openProject(page, P, 'Plot')
  // P's conversation ran only in its worktrees: it is listed under them.
  await page.getByRole('button', { name: /^Workspace:/ }).first().click()
  await page.getByRole('listbox', { name: 'Workspaces' }).getByRole('option', { name: /Bed B/ }).click()
  await page.locator('.card', { hasText: 'HOLD plot work' }).click()
  await page.locator('.author-where').first().waitFor()
  await shot(page, '04-plot-two-accounts')
  await app.close()
  app = undefined

  // ======================= CROSS-09 =======================
  step('CROSS-09 v0.1.5 writes its state')
  const stateL = join(root, 'state-legacy')
  const L = repo('legacy-garden')
  if (!existsSync(V015)) throw new Error(`No v0.1.5 build at ${V015}`)
  const legacy = await electron.launch({ executablePath: V015, env: {
    HOME: home, USER: process.env.USER ?? '', LOGNAME: process.env.USER ?? '', SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'), TMPDIR: process.env.TMPDIR ?? '/tmp',
    PATH: LAUNCHD_PATH, COCKPIT_HOME: stateL, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/accounts-agent'), COCKPIT_PROOF_ACCOUNT_LOG: log,
  } })
  page = await legacy.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, L, 'Legacy garden')
  const legacyThread = (await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: L, text: 'written by 0.1.5', settings: { agent: 'claude' } })).data!.id
  await until('0.1.5 reply', async () => (await replies(page, legacyThread)).includes('Done as alice@example.com'), 30_000)
  await legacy.close()
  const eventsFile = join(stateL, 'threads', legacyThread, 'events.jsonl')
  const originalEvents = readFileSync(eventsFile, 'utf8')
  const originalProjects = readFileSync(join(stateL, 'projects.json'), 'utf8')
  const legacyFiles = readdirSync(stateL).sort()
  const legacyMetaSha = sha(join(stateL, 'threads', legacyThread, 'meta.json'))
  console.log(`  (0.1.5 wrote: ${legacyFiles.join(', ')})`)

  step('CROSS-09 this build opens it: account, worktree, a failed operation')
  app = await launchPackagedApp(accountsEnv(stateL))
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('tab', { selected: true }).first().waitFor()
  const lid = await projectId(page, L)
  const migratedThreads = await get<Array<{ meta: { id: string } }>>(page, '/api/threads')
  check('CROSS-09 the 0.1.5 conversation and project open as they were', migratedThreads.some((t) => t.meta.id === legacyThread) && (await replies(page, legacyThread)).includes('Done as alice@example.com'))
  const profileCount = (): number => (existsSync(join(stateL, 'account-profiles')) ? readdirSync(join(stateL, 'account-profiles')).length : 0)
  const before = profileCount()
  const failedSignIn = await addAccount(page, 'Broken', 'not-a-code')
  check('CROSS-09 a failed sign-in adds no account and keeps the selection',
    failedSignIn.startsWith('alert:') && profileCount() === before && (await get<{ selection: { claude: string } }>(page, `/api/projects/${lid}/accounts`)).selection.claude === 'default-claude', failedSignIn)
  const addedL = await addAccount(page, 'Work C', 'ok:carol@example.com')
  check('CROSS-09 an account profile is created on the upgraded state', addedL.startsWith('chosen:Work C'), addedL)
  const badCreate = await call(page, 'POST', `/api/projects/${lid}/workspaces`, { name: 'Nope', base: 'no-such-ref' })
  const wt = (await call<{ workspace: { id: string; cwd: string } }>(page, 'POST', `/api/projects/${lid}/workspaces`, { name: 'Upgrade bed' })).data!.workspace
  check('CROSS-09 a refused worktree leaves nothing; a good one is created',
    badCreate.status === 409 && readdirSync(root).filter((n) => n.startsWith('legacy-garden-worktree-')).length === 1 && existsSync(wt.cwd))
  await call(page, 'POST', `/api/threads/${legacyThread}/messages`, { text: 'continue the 0.1.5 conversation in the new worktree', workspaceId: wt.id })
  await until('continued', async () => (await replies(page, legacyThread)).includes('Done as carol@example.com'), 30_000)
  await shot(page, '09-upgraded')
  await app.close()
  app = undefined
  await new Promise((r) => setTimeout(r, 1000))
  check('CROSS-09 Quit leaves no agent process behind', fixtureProcs().length === 0, fixtureProcs().join(','))

  step('CROSS-09 reopen')
  app = await launchPackagedApp(accountsEnv(stateL))
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.getByRole('tab', { selected: true }).first().waitFor()
  const after = readFileSync(eventsFile, 'utf8')
  check('CROSS-09 the original conversation log is intact: every line 0.1.5 wrote is still there, unchanged, first',
    after.startsWith(originalEvents) && after.length > originalEvents.length)
  const projectsNow = JSON.parse(readFileSync(join(stateL, 'projects.json'), 'utf8')) as unknown
  const originalList = JSON.parse(originalProjects) as unknown
  const pathsOf = (v: unknown): string[] => JSON.stringify(v).match(/"path":"[^"]+"/g) ?? []
  check('CROSS-09 the original project record is kept', pathsOf(originalList).every((p) => pathsOf(projectsNow).includes(p)))
  check('CROSS-09 no file 0.1.5 wrote went missing', legacyFiles.every((f) => existsSync(join(stateL, f))), legacyFiles.join(','))
  const ws = await get<{ workspaces: Array<{ id: string; kind: string; lifecycle: string }> }>(page, `/api/projects/${lid}/workspaces`)
  check('CROSS-09 after reopening: the worktree, the account and the continued conversation are all there',
    ws.workspaces.some((w) => w.id === wt.id && w.lifecycle === 'active') && (await get<{ selection: { claude: string } }>(page, `/api/projects/${lid}/accounts`)).selection.claude !== 'default-claude'
      && (await replies(page, legacyThread)).filter((r) => r.startsWith('Done as')).length === 2)
  check('CROSS-09 the conversation\'s metadata was updated in place (same file), not replaced by another conversation', existsSync(join(stateL, 'threads', legacyThread, 'meta.json')) && sha(join(stateL, 'threads', legacyThread, 'meta.json')) !== legacyMetaSha)
  await app.close()
  app = undefined
} catch (error) {
  const window = app ? await app.firstWindow().catch(() => undefined) : undefined
  if (window) await shot(window, 'failed').catch(() => undefined)
  check('the proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await app?.close().catch(() => undefined)
}
await new Promise((r) => setTimeout(r, 1000))
check('no stand-in agent process is left', fixtureProcs().length === 0)
console.log(`  state kept in ${root}`)
finish('proof:cross-accounts-worktrees')
