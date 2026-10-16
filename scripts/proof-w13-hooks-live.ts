// Background packaged proof that an approved project hook runs in the pinned Claude session (W13 U1).
// One planned provider attempt, not a loop: it checks the borrowed login's identity in the packaged
// app's own spawn context first and stops before sending if it is unknown or differs. Every outcome,
// pass or the first failure, leaves a receipt in COCKPIT_PROOF_DIR before anything is cleaned up.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { launchPackagedApp } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const PINS = {
  cli: '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081',
  cliVersion: /^2\.1\.220 /,
  node: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b',
}
// Names only: whether any is present is recorded, never a value.
const AUTH_SELECTORS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR'] as const

const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const evidence = process.env.COCKPIT_PROOF_DIR
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR
assert.ok(evidence && privateDir, 'Set COCKPIT_PROOF_DIR (shared, sanitized) and COCKPIT_PROOF_PRIVATE_DIR (private)')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
mkdirSync(privateDir, { recursive: true, mode: 0o700 })
const writeJson = (dir: string, name: string, value: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  return path
}

interface Step { readonly name: string; readonly ok: boolean; readonly detail?: string; readonly at: string }
const steps: Step[] = []
const output: string[] = []
/** Runs one check; the first failure is recorded and stops the proof. */
async function step<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  try {
    const value = await run()
    steps.push({ name, ok: true, at: new Date().toISOString() })
    return value
  } catch (error) {
    steps.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })
    throw error
  }
}

const startedAt = new Date().toISOString()
const repo = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim()
const source = { head: repo(['rev-parse', 'HEAD']), dirty: repo(['status', '--porcelain']) !== '' }
const appBundle = process.env.COCKPIT_APP ?? ''
const cli = process.env.COCKPIT_W13_CLAUDE ?? ''
const accountId = process.env.COCKPIT_PROOF_ACCOUNT_ID ?? ''
let root: string | undefined
let app: ElectronApplication | undefined
let verdict: 'passed' | 'stopped' = 'stopped'
const facts: Record<string, unknown> = {}

try {
  await step('pins: background, package, CLI and Node bytes', () => {
    assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1', 'Proof must stay in the background')
    assert.ok(appBundle && existsSync(appBundle), 'Set COCKPIT_APP to the exact proof package')
    assert.ok(cli, 'Set COCKPIT_W13_CLAUDE to the pinned Claude')
    assert.equal(hash(realpathSync(cli)), PINS.cli, 'Claude bytes are not the pinned build')
    assert.match(execFileSync(cli, ['--version'], { encoding: 'utf8' }), PINS.cliVersion)
    assert.equal(hash(process.execPath), PINS.node, 'Node bytes are not the pinned build')
    facts.package = { asar: hash(join(appBundle, 'Contents/Resources/app.asar')), executable: hash(join(appBundle, 'Contents/MacOS/Cockpit')) }
    writeJson(evidence, 'package-manifest.json', { app: 'Cockpit.app (proof)', ...facts.package as object, source })
  })

  // The app borrows this established login by its literal profile path (electron/proof-account-context.ts).
  // No link to the profile is made: a link changes the CLI's credential namespace (W13 U0).
  const account = await step('account: an existing managed Claude record', () => {
    assert.match(accountId, /^[0-9a-f-]{36}$/, 'Set COCKPIT_PROOF_ACCOUNT_ID to the already signed-in managed Claude account; this proof never signs in')
    const accountRoot = join(process.env.HOME ?? '', '.agent-cockpit')
    const file = JSON.parse(readFileSync(join(accountRoot, 'accounts.json'), 'utf8')) as {
      accounts: Array<{ id: string; agent: string; mode: string; isolation: string; generation: number }>
    }
    const found = file.accounts.find((entry) => entry.id === accountId)
    assert.ok(found && found.agent === 'claude' && found.mode === 'managed' && found.isolation === 'CLAUDE_CONFIG_DIR',
      'COCKPIT_PROOF_ACCOUNT_ID is not a managed Claude account in ~/.agent-cockpit')
    const profile = join(accountRoot, 'account-profiles', accountId)
    const settingsFile = join(profile, 'settings.json')
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) as { apiKeyHelper?: unknown; env?: Record<string, unknown> } : {}
    // Private: the locator itself. Shared: only whether ambient selectors could substitute another principal.
    writeJson(privateDir, 'provider-context-private.json', { accountId, literalProfileDir: profile, canonicalProfileDir: realpathSync(profile) })
    facts.context = {
      home: 'real HOME (Keychain)', userLognamePassed: Boolean(process.env.USER) && Boolean(process.env.LOGNAME ?? process.env.USER),
      literalEqualsCanonical: realpathSync(profile) === profile,
      profileApiKeyHelper: settings.apiKeyHelper !== undefined,
      profileEnvAuthSelectors: AUTH_SELECTORS.filter((name) => settings.env?.[name] !== undefined),
      generation: found.generation,
    }
    return found
  })

  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-w13-hook-live-')))
  const project = join(root, 'project'), marker = join(root, 'hook-started'), state = join(root, 'state')
  // Disposable metadata only: a copy of the one record and the project's choice of it, no profile folders.
  mkdirSync(state, { recursive: true, mode: 0o700 })
  writeFileSync(join(state, 'accounts.json'), JSON.stringify({ version: 1, revision: 1, accounts: [account],
    selections: { [project]: { claude: accountId } } }), { mode: 0o600 })
  mkdirSync(join(project, '.claude'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Isolated W13 hook proof\n')
  const script = join(project, 'session-start.mjs')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'W13-HOOK-STARTED')\n`)
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `${process.execPath} ${script}` }] }],
  } }))

  // HOME stays real for Keychain. Cockpit metadata stays in disposable state; Claude may write its own
  // session data to the borrowed profile. A borrowed account that fails its checks stops the app at startup.
  const page = await step('launch: packaged app in the background', async () => {
    app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: dirname(cli), COCKPIT_PROOF_ACCOUNT_ID: accountId })
    // Observed in the running main process, not assumed from the launcher: what agents would inherit.
    const keys = await app.evaluate(() => Object.keys(process.env))
    facts.context = { ...facts.context as object, appEnvAuthSelectors: AUTH_SELECTORS.filter((name) => keys.includes(name)) }
    assert.deepEqual((facts.context as { appEnvAuthSelectors: string[] }).appEnvAuthSelectors, [], 'An ambient auth selector could substitute another account')
    const first = await app.firstWindow()
    first.setDefaultTimeout(20_000)
    return first
  })
  await openProject(page, project, 'W13 hook proof')

  await step('selection: the project runs on the borrowed account', async () => {
    const selected = await page.evaluate(async (path) => {
      const listed = await (await fetch('/api/projects')).json() as { data: Array<{ projectId?: string; path: string }> }
      const id = listed.data.find((entry) => entry.path === path)?.projectId
      if (!id) return undefined
      const choice = await (await fetch(`/api/projects/${id}/accounts`)).json() as { data: { selection: { claude: string } } }
      return choice.data.selection.claude
    }, project)
    assert.equal(selected, accountId, 'The disposable project did not select the borrowed account')
  })

  // Read-only native identity query (`claude auth status`) in the packaged app's own spawn context. In
  // proof mode any other principal, or none, bumps the copy's generation and the service refuses it.
  await step('identity preflight: the packaged context reports the borrowed principal', async () => {
    const checked = await apiPost(page, `/api/accounts/${accountId}/refresh`, {}) as
      { data?: { changed: boolean; account: { generation: number; identity?: { state: string } } }; error?: string }
    facts.identityPreflight = { ok: Boolean(checked.data), changed: checked.data?.changed, identityState: checked.data?.account.identity?.state,
      generationBefore: account.generation, generationAfter: checked.data?.account.generation, error: checked.error }
    assert.ok(checked.data, `Identity preflight refused: ${checked.error ?? 'no response'}. Stop: no sign-in, no account switch, no retry`)
    assert.equal(checked.data.account.identity?.state, 'known', 'The borrowed login reports no account. Stop before sending')
    assert.equal(checked.data.changed, false, 'The borrowed login reports a different account. Stop before sending')
    assert.equal(checked.data.account.generation, account.generation)
  })

  const review = await step('hook review: exactly the one synthetic SessionStart hook', async () => {
    const found = await page.evaluate(async (path) => (await (await fetch(`/api/projects/claude-hooks?path=${encodeURIComponent(path)}`)).json()).data,
      project) as { revision: string; review: Array<{ event: string; referencedFiles: Array<{ path: string; hash: string }> }>; unavailable: unknown[] }
    // More than one entry means real hooks leaked into the fixture: fail rather than approve them.
    assert.equal(found.review.length, 1, `Expected only the synthetic hook, found ${found.review.length}`)
    assert.equal(found.review[0]?.event, 'SessionStart')
    assert.equal(found.review[0]?.referencedFiles[0]?.hash, hash(script))
    assert.deepEqual(found.unavailable, [])
    return found
  })
  await apiPost(page, '/api/projects/claude-hooks', { path: project, revision: review.revision })
  await apiPost(page, '/api/projects', { path: project, claudeHooks: true, claudeMcp: false })

  const events = await step('turn: one no-tools model turn completes', async () => {
    const created = await apiPost(page, '/api/threads', { projectPath: project, text: 'Reply exactly W13HOOKREADY. Do not use tools.',
      settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'inherit', mcpSetup: 'off' } }) as
      { data?: { id: string }; error?: string }
    assert.ok(created.data?.id, created.error ?? 'Thread creation failed')
    let seen: Array<{ kind: string; text?: string; ok?: boolean; name?: string }> = []
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      seen = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data.events.map((row: { event: unknown }) => row.event), created.data.id)
      if (seen.some((event) => event.kind === 'result')) break
      await page.waitForTimeout(500)
    }
    for (const event of seen) output.push(`${event.kind}${event.name ? ` ${event.name}` : ''}${event.text ? `: ${event.text.slice(0, 200)}` : ''}`)
    const result = seen.find((event) => event.kind === 'result')
    assert.equal(result?.ok, true, result?.text?.includes('Not logged in')
      ? 'The borrowed Claude profile did not authenticate. Stop: no sign-in, no account switch, no retry'
      : 'The packaged Claude turn did not succeed')
    assert.ok(!seen.some((event) => event.kind === 'tool_use'), 'The turn used a tool')
    return seen
  })

  await step('hook: the reviewed SessionStart hook ran and the reply arrived', () => {
    assert.equal(existsSync(marker), true, 'Reviewed SessionStart hook did not run')
    assert.equal(readFileSync(marker, 'utf8'), 'W13-HOOK-STARTED')
    assert.ok(events.some((event) => event.kind === 'assistant_text' && event.text?.includes('W13HOOKREADY')), 'No W13HOOKREADY reply')
    facts.hookSourceHash = hash(script)
  })
  verdict = 'passed'
} catch (error) {
  console.error(`[w13-u1] stopped: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  // Nothing under root links to the real profile, so removing it cannot reach the login.
  if (root) rmSync(root, { recursive: true, force: true })
  writeFileSync(join(evidence, 'output.txt'), `${output.join('\n')}\n`, { mode: 0o600 })
  writeJson(evidence, 'provider-context.json', { context: facts.context, identityPreflight: facts.identityPreflight })
  const files = ['package-manifest.json', 'provider-context.json', 'output.txt'].filter((name) => existsSync(join(evidence, name)))
  writeJson(evidence, 'receipt.json', {
    scenario: 'W13-U1 packaged borrowed-account hook proof', startedAt, finishedAt: new Date().toISOString(), source,
    command: 'scripts/proof-w13-hooks-live.ts', provider: { cli: 'claude 2.1.220', cliHash: PINS.cli, nodeHash: PINS.node },
    package: facts.package, account: { alias: 'borrowed managed Claude', generation: (facts.context as { generation?: number } | undefined)?.generation },
    workspace: 'disposable project and Cockpit state', steps, verdict,
    // Inferred from code, not observed separately: the launch awaits the Cockpit MCP bridge (hostReady) before the first send.
    limitation: 'Bridge authentication is implied by a completed turn, not asserted on its own. Claude may write its own session data to the borrowed profile.',
    evidenceHashes: Object.fromEntries(files.map((name) => [name, hash(join(evidence, name))])),
    cleanup: { disposableRootRemoved: root ? !existsSync(root) : true, appClosed: true },
  })
  console.log(`[w13-u1] ${verdict}; receipt ${join(evidence, 'receipt.json')}`)
}
