// Packaged gate for order 16 (account profiles, W12-01–W12-04) with stand-in CLIs only: Claude is
// scripts/fixtures/accounts-agent/claude and Codex …/codex, each signed in to whichever account its
// own context folder holds. No provider usage and no real CLI: the app gets a throwaway HOME and the
// stand-in login shell. The real two-account check (David's sign-in clicks) is separate.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:accounts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-accounts-proof-'))
const home = join(root, 'home'), state = join(root, 'state'), alpha = join(root, 'alpha'), beta = join(root, 'beta')
const log = join(root, 'launches.log')
for (const dir of [join(home, '.claude'), join(home, '.codex'), alpha, beta]) mkdirSync(dir, { recursive: true })
writeFileSync(join(home, '.claude', '.fixture-identity'), 'alice@example.com 10\n')
writeFileSync(join(home, '.codex', '.fixture-identity'), 'alice@example.com 20\n')
writeFileSync(join(alpha, 'README.md'), '# alpha\n')
writeFileSync(join(beta, 'README.md'), '# beta\n')
mkdirSync(PROOF_DIR, { recursive: true })
const profilesDir = join(state, 'account-profiles')

async function until(label: string, test: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await Promise.resolve().then(test).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `accounts-${name}.png`) })
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Agent settings' })
const accountBox = (page: Page): Locator => picker(page).getByRole('combobox', { name: 'Account' })
const chosen = (page: Page): Promise<string> => accountBox(page).evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? '')
const openPicker = async (page: Page): Promise<void> => {
  if (await picker(page).count() === 0) await page.getByRole('button', { name: 'Agent settings' }).click()
  await accountBox(page).waitFor()
  // Ready = both answers in: the box is enabled and no longer says Checking….
  await until('accounts loaded', async () => await accountBox(page).isEnabled() && (await chosen(page)) !== 'Checking…')
}
const closePicker = async (page: Page): Promise<void> => { if (await picker(page).count()) await page.keyboard.press('Escape') }
// An agent without a CLI here is labelled "<name> Unavailable": match the start of the name.
const radio = (page: Page, name: string) => picker(page).getByRole('radio', { name: new RegExp(`^${name}`) }).click()
const launches = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
const profiles = (): string[] => (existsSync(profilesDir) ? readdirSync(profilesDir) : [])
const meter = (page: Page): Locator => picker(page).getByRole('meter', { name: 'Claude Code usage' })
type ThreadRow = { meta: { id: string; title: string; projectPath: string }; status: string }
const threads = (page: Page): Promise<ThreadRow[]> => page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: ThreadRow[] }).data)
const threadText = (page: Page, id: string): Promise<string[]> => page.evaluate(async (tid) => {
  const body = await (await fetch(`/api/threads/${tid}/events`)).json() as { data: { events: Array<{ event: { kind: string; text?: string } }> } }
  return body.data.events.filter((e) => e.event.kind === 'assistant_text').map((e) => e.event.text ?? '')
}, id)

async function addAccount(page: Page, label: string): Promise<void> {
  await accountBox(page).selectOption('__add')
  await picker(page).getByLabel('Account name').fill(label)
  await picker(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await picker(page).getByLabel('Sign-in link').waitFor()
}

let app: ElectronApplication | undefined
try {
  app = await launchPackagedApp({
    HOME: home, SHELL: join(ROOT, 'scripts/fixtures/wave10-cli/login-shell'), COCKPIT_HOME: state,
    COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/accounts-agent'), COCKPIT_PROOF_ACCOUNT_LOG: log,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, beta, 'Beta')
  await openProject(page, alpha, 'Alpha')

  // W12-01. The CLI default first, then two managed profiles through the CLIs' own sign-in.
  await openPicker(page)
  check('01 the picker shows the project account: the CLI default and who it is', (await chosen(page)) === 'Use CLI default · a…@example.com · pro', await chosen(page))
  await shot(page, '01-default')
  await addAccount(page, 'Work B')
  const link = (await picker(page).getByLabel('Sign-in link').textContent()) ?? ''
  check('01 Add account shows Claude’s sign-in link with the private-window advice', link.startsWith('https://claude.com/cai/oauth/authorize?')
    && (await picker(page).getByText('Open this link in a private window').count()) === 1, link.slice(0, 60))
  await shot(page, '01-signin-link')
  await picker(page).getByLabel('Sign-in code').fill('ok:bob@example.com')
  await picker(page).getByRole('button', { name: 'Continue', exact: true }).click()
  check('01 the signed-in profile is added and chosen for this project', await until('Work B chosen', async () => (await chosen(page)) === 'Work B · b…@example.com · pro'), await chosen(page))
  const [workB] = profiles()
  check('01 its sign-in did not open a browser (BROWSER suppressed)', workB !== undefined && readFileSync(join(profilesDir, workB, '.fixture-browser'), 'utf8').trim() === '/usr/bin/true')
  await shot(page, '01-work-b-chosen')

  await radio(page, 'Codex')
  await until('codex default', async () => (await chosen(page)).startsWith('Use CLI default · a…@example.com · plus'))
  await addAccount(page, 'Second C')
  check('01 Codex shows its localhost-callback link and no code box', ((await picker(page).getByLabel('Sign-in link').textContent()) ?? '').startsWith('https://auth.openai.com/')
    && (await picker(page).getByLabel('Sign-in code').count()) === 0 && (await picker(page).getByText('finishes by itself').count()) === 1)
  const pending = profiles().find((id) => id !== workB)
  // What the browser finishing the sign-in does: Codex's own callback receives it.
  if (pending) writeFileSync(join(profilesDir, pending, '.fixture-callback'), 'ok:carol@example.com\n')
  check('01 the Codex profile is added and chosen', await until('Second C chosen', async () => (await chosen(page)) === 'Second C · c…@example.com · plus'), await chosen(page))
  await shot(page, '01-codex-second')

  // Antigravity and OpenCode say why they stay on the CLI default instead of offering a switch.
  await radio(page, 'Antigravity')
  const agyNote = picker(page).locator('.account-default-only')
  check('01 Antigravity: default only, with the reason', await until('agy note', async () => /^Account: CLI default\. Antigravity has no supported way to keep a second account separate/.test((await agyNote.textContent()) ?? '')))
  await shot(page, '01-antigravity-default-only')
  await radio(page, 'OpenCode')
  check('01 OpenCode: default only, with the reason', await until('opencode note', async () => /OpenCode has no supported way/.test((await agyNote.textContent()) ?? '')))
  await radio(page, 'Claude Code')
  await until('claude again', async () => (await chosen(page)).startsWith('Work B'))
  await closePicker(page)

  // Concurrent independent contexts: Beta on the default (a long turn) and Alpha on Work B at once.
  const betaRun = await apiPost(page, '/api/threads', { projectPath: beta, text: 'HOLD beta works on the default', settings: { agent: 'claude' } }) as { data: { id: string } }
  const alphaRun = await apiPost(page, '/api/threads', { projectPath: alpha, text: 'alpha on work b', settings: { agent: 'claude' } }) as { data: { id: string } }
  const alphaId = alphaRun.data.id, betaId = betaRun.data.id
  await until('alpha reply', async () => (await threadText(page, alphaId)).includes('Done as bob@example.com'))
  const overlap = (await threads(page)).find((t) => t.meta.id === betaId)?.status
  check('01 Alpha answered as Work B while Beta was still working as the default', (await threadText(page, alphaId)).includes('Done as bob@example.com') && overlap === 'working', `beta ${overlap}`)
  check('01 each ran in its own context', launches().some((l) => l.startsWith(`claude ctx=${join(profilesDir, workB ?? '?')} account=bob@example.com`))
    && launches().some((l) => l.startsWith('claude ctx=default account=alice@example.com')), launches().join(' | '))
  await until('beta reply', async () => (await threadText(page, betaId)).includes('Done as alice@example.com'), 15_000)
  const profileFiles = profiles().flatMap((id) => readdirSync(join(profilesDir, id)).map((f) => readFileSync(join(profilesDir, id, f), 'utf8'))).join('\n')
  check('01 default login unchanged and nothing copied from it into a profile',
    readFileSync(join(home, '.claude', '.fixture-identity'), 'utf8') === 'alice@example.com 10\n' && readFileSync(join(home, '.codex', '.fixture-identity'), 'utf8') === 'alice@example.com 20\n' && !profileFiles.includes('alice'))

  // W12-02. Beta works again: its own change is refused; Alpha, idle, changes meanwhile.
  await apiPost(page, `/api/threads/${betaId}/messages`, { text: 'HOLD beta second long turn' })
  await openProject(page, beta, 'Beta')
  await openPicker(page)
  await accountBox(page).selectOption({ label: 'Work B · b…@example.com · pro' })
  const alert = picker(page).getByRole('alert')
  check('02 a project whose conversation is working refuses the change', await until('refused', async () => /still working/.test((await alert.textContent()) ?? '')), (await alert.textContent().catch(() => '')) ?? '')
  check('02 and keeps its account', await until('beta kept', async () => (await chosen(page)).startsWith('Use CLI default')), await chosen(page))
  await shot(page, '02-busy-refused')
  await closePicker(page)
  const alphaProject = await page.evaluate(async (p) => ((await (await fetch('/api/projects')).json()) as { data: Array<{ path: string; projectId: string }> }).data.find((x) => x.path === p)?.projectId, alpha)
  const changed = await apiPost(page, `/api/projects/${alphaProject}/accounts/claude`, { accountId: 'default-claude' }) as { data?: { selection: { claude: string } } }
  const betaStill = (await threads(page)).find((t) => t.meta.id === betaId)?.status
  check('02 the idle project changes while the other works', changed.data?.selection.claude === 'default-claude' && betaStill === 'working', `beta ${betaStill}`)
  check('02 the working one finishes on the account it started with', await until('beta second reply', async () => (await threadText(page, betaId)).filter((t) => t === 'Done as alice@example.com').length === 2, 15_000))

  // W12-03. Alpha's conversation continues on the CLI default: labelled, fresh session, handoff.
  await openProject(page, alpha, 'Alpha')
  await page.getByText('alpha on work b').first().click()
  const changeNote = page.getByText(/^Account changed from Work B \(b…@example\.com · pro\) to CLI default \(a…@example\.com · pro\)\. Your next message starts a new Claude Code session on it; the conversation so far goes with it\.$/)
  check('03 the conversation says the account changed and that its history goes along, before the next message', await until('change note', async () => (await changeNote.count()) === 1))
  await shot(page, '03-account-changed')
  await messageBox(page).fill('continue on the default')
  await messageBox(page).press('Enter')
  check('03 the new account actually runs', await until('default reply', async () => (await threadText(page, alphaId)).includes('Done as alice@example.com')))
  const last = launches().findLast((l) => l.startsWith('claude ')) ?? ''
  check('03 a fresh session, not a resume of Work B’s, with the conversation as a handoff', /^claude ctx=default account=alice@example\.com session=\S+ resume=- handoff=yes( cwd=\S+)?$/.test(last), last)
  await shot(page, '03-continued')

  // Usage labels: each account's own report only.
  await openPicker(page)
  check('02 the picker shows the default’s usage on the default', await until('default meter', async () => (await meter(page).getAttribute('aria-valuenow')) === '10'), String(await meter(page).getAttribute('aria-valuenow').catch(() => null)))
  await accountBox(page).selectOption({ label: 'Work B · b…@example.com · pro' })
  check('02 and Work B’s own usage on Work B', await until('work b meter', async () => (await meter(page).getAttribute('aria-valuenow')) === '12'), String(await meter(page).getAttribute('aria-valuenow').catch(() => null)))
  await shot(page, '02-usage-work-b')

  // W12-04. A failed sign-in changes nothing.
  const before = profiles().length
  await addAccount(page, 'Broken')
  await picker(page).getByLabel('Sign-in code').fill('nope')
  await picker(page).getByRole('button', { name: 'Continue', exact: true }).click()
  check('04 a failed sign-in says nothing was added or changed', await until('failed', async () => /No account was added and no project’s account changed/.test((await picker(page).getByRole('alert').first().textContent()) ?? ''), 20_000))
  check('04 the selection is unchanged and no profile is left behind', profiles().length === before && (await accountBox(page).evaluate((s: HTMLSelectElement) => [...s.options].find((o) => o.value === s.value && o.value !== '__add')?.textContent ?? 'add')) !== 'Broken', `${profiles().length} vs ${before}`)
  await shot(page, '04-signin-failed')
  await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await until('back to Work B', async () => (await chosen(page)).startsWith('Work B'))

  // Removing a profile in use is refused; once idle it is signed out and deleted, projects moved to the default.
  await closePicker(page)
  await apiPost(page, `/api/threads/${alphaId}/messages`, { text: 'HOLD alpha on work b again' })
  await openPicker(page)
  await picker(page).getByRole('button', { name: 'Remove “Work B”…' }).click()
  await picker(page).getByRole('button', { name: 'Remove', exact: true }).click()
  check('04 removing a profile a conversation runs on is refused', await until('remove refused', async () => /1 conversation is running on “Work B”/.test((await picker(page).getByRole('alert').first().textContent()) ?? '')))
  await shot(page, '04-remove-refused')
  await until('alpha idle', async () => (await threads(page)).find((t) => t.meta.id === alphaId)?.status !== 'working', 15_000)
  await page.waitForTimeout(500)
  await picker(page).getByRole('button', { name: 'Remove', exact: true }).click()
  check('04 once idle it is removed: signed out in its context, folder deleted, project on the default',
    await until('removed', async () => /Removed “Work B”/.test((await picker(page).getByRole('status').first().textContent()) ?? '') && !profiles().includes(workB ?? '?')),
    (await picker(page).getByRole('status').first().textContent().catch(() => '')) ?? '')
  check('04 the default sign-in is untouched by the removal', readFileSync(join(home, '.claude', '.fixture-identity'), 'utf8') === 'alice@example.com 10\n')
  await shot(page, '04-removed')
  await closePicker(page)

  // The default's identity changes outside Cockpit: shown in the picker and the conversation; its old usage is not shown.
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'zed@example.com 50\n')
  await openPicker(page)
  check('04 an outside change of the default sign-in is shown in the picker', await until('zed', async () => (await chosen(page)) === 'Use CLI default · z…@example.com · pro'), await chosen(page))
  check('04 and the earlier identity’s usage is not shown as this one’s', (await meter(page).count()) === 0)
  await closePicker(page)
  const outside = page.getByText(/^Claude Code's default sign-in changed outside Cockpit \(was a…@example\.com · pro\); it is now z…@example\.com · pro\./)
  check('04 the idle conversation says so before its next message', await until('identity note', async () => (await outside.count()) === 1))
  await shot(page, '04-identity-changed')
  writeFileSync(join(home, '.claude', '.fixture-identity'), '')
  await openPicker(page)
  check('04 an unconfirmed identity is labelled unknown, not the previous account', await until('unknown', async () => (await chosen(page)) === 'Use CLI default · account unknown')
    && (await picker(page).getByText(/did not confirm who is signed in here/).count()) === 1, await chosen(page))
  await shot(page, '04-identity-unknown')
  await closePicker(page)
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'alice@example.com 10\n')

  // Project settings show the same choice.
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByRole('menuitem', { name: 'Alpha settings…' }).click()
  const codexGroup = page.getByRole('group', { name: 'Codex account' })
  check('settings: project settings show the same account per agent', await until('settings codex', async () =>
    (await codexGroup.getByRole('combobox', { name: 'Account' }).evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? '')) === 'Second C · c…@example.com · plus'))
  await page.locator('.project-accounts').scrollIntoViewIfNeeded()
  await shot(page, 'settings-accounts')
  await page.keyboard.press('Escape')

  // Dark and narrow.
  await setTheme(page, 'Dark')
  await page.setViewportSize({ width: 980, height: 640 })
  await openPicker(page)
  const fits = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="Agent settings"]')?.getBoundingClientRect()
    return { page: document.documentElement.scrollWidth <= innerWidth, panel: panel !== undefined && panel.left >= 0 && panel.right <= innerWidth }
  })
  check('narrow: the picker with its account choice fits a 980 px window', fits.page && fits.panel, JSON.stringify(fits))
  await shot(page, 'narrow-dark')
  await closePicker(page)
  await setTheme(page, 'Light')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  if (app) await (await app.firstWindow()).screenshot({ path: join(PROOF_DIR, 'accounts-failure.png') }).catch(() => {})
} finally {
  await app?.close().catch(() => {})
}
finish('PROOF ACCOUNTS (order 16)')
