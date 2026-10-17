// Background packaged proofs in the pinned Claude session under a borrowed managed login (W13).
// COCKPIT_PROOF_SCENARIO=hooks (default, U1): an approved project hook runs.
// COCKPIT_PROOF_SCENARIO=memory (U5): a project's selected native memory loads, from a synthetic
// stand-in for the CLI default profile, with its marker absent from every prompt.
// COCKPIT_PROOF_SCENARIO=skill (U6): the user's own skill, chosen for the project, runs by its bare name
// from the private plugin projection.
// COCKPIT_PROOF_SCENARIO=policy (U3c): one approved PreToolUse hook, three Write turns. When it allows, the
// file appears (the control); when it fails, or hangs past its timeout, the file must not.
// One planned provider attempt, not a loop: it checks the borrowed login's identity in the packaged
// app's own spawn context first and stops before sending if it is unknown or differs. Every outcome,
// pass or the first failure, leaves a receipt in COCKPIT_PROOF_DIR before anything is cleaned up.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { claudeProjectSlug } from '../server/agents/setup/claude-inventory.ts'
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
const scenario = process.env.COCKPIT_PROOF_SCENARIO ?? 'hooks'
if (!['hooks', 'memory', 'skill', 'policy'].includes(scenario)) throw new Error('COCKPIT_PROOF_SCENARIO is hooks, memory, skill or policy')
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
  // Policy scenario: one reviewed hook on every tool call, its behaviour set by a data file it reads (not part
  // of its argv, so one review covers all three turns). The hung mode ends by ALLOWING after 30 s: only the
  // runner's 3 s timeout can stop the Write; Claude's own timeout would let it through.
  const policyMode = join(root, 'policy-mode'), policyLog = join(root, 'policy-log')
  const policyScript = join(project, 'policy-hook.mjs')
  if (scenario === 'policy') {
    writeFileSync(policyScript, [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      "let input = ''",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      `  const mode = readFileSync(${JSON.stringify(policyMode)}, 'utf8').trim()`,
      "  let tool = ''",
      "  try { tool = JSON.parse(input).tool_name ?? '' } catch { tool = 'unreadable' }",
      `  appendFileSync(${JSON.stringify(policyLog)}, mode + ' ' + tool + '\\n')`,
      "  if (mode === 'allow') process.exit(0)",
      "  if (mode === 'fail') process.exit(1)",
      "  setTimeout(() => process.exit(0), 30_000)",
      "})", ''].join('\n'))
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: `${process.execPath} ${policyScript}`, timeout: 3 }] }],
    } }))
  }

  // Memory scenario: a private synthetic default profile holds this project's memory; the marker is in
  // that file only, never in a prompt.
  const defaultProfile = join(root, 'default-claude')
  const memoryMarker = `quill-${randomBytes(4).toString('hex')}`
  if (scenario === 'memory') {
    const memoryDir = join(defaultProfile, 'projects', claudeProjectSlug(project), 'memory')
    mkdirSync(memoryDir, { recursive: true, mode: 0o700 })
    for (const dir of [defaultProfile, join(defaultProfile, 'projects')]) execFileSync('chmod', ['700', dir])
    writeFileSync(join(memoryDir, 'MEMORY.md'), `# Project memory\n\nThe handoff word for this project is ${memoryMarker}.\n`, { mode: 0o600 })
    writeJson(privateDir, 'memory-marker-private.json', { memoryMarker })
  }
  const skillMarker = `W13SKILL${randomBytes(6).toString('hex').toUpperCase()}`
  if (scenario === 'skill') {
    const skillDir = join(defaultProfile, 'skills', 'w13-proof-skill')
    mkdirSync(skillDir, { recursive: true, mode: 0o700 })
    for (const dir of [defaultProfile, join(defaultProfile, 'skills')]) execFileSync('chmod', ['700', dir])
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: w13-proof-skill\ndescription: Synthetic W13 packaged skill proof.\n---\n\nWhen invoked, reply with exactly ${skillMarker}| followed by the invocation argument. Do not use tools.\n`, { mode: 0o600 })
    writeJson(privateDir, 'skill-marker-private.json', { skillMarker })
  }

  // HOME stays real for Keychain. Cockpit metadata stays in disposable state; Claude may write its own
  // session data to the borrowed profile. A borrowed account that fails its checks stops the app at startup.
  const page = await step('launch: packaged app in the background', async () => {
    app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: dirname(cli), COCKPIT_PROOF_ACCOUNT_ID: accountId,
      ...(scenario === 'memory' || scenario === 'skill' ? { COCKPIT_PROOF_DEFAULT_CLAUDE_PROFILE: defaultProfile } : {}) })
    // Observed in the running main process, not assumed from the launcher: what agents would inherit.
    const keys = await app.evaluate(() => Object.keys(process.env))
    facts.context = { ...facts.context as object, appEnvAuthSelectors: AUTH_SELECTORS.filter((name) => keys.includes(name)) }
    assert.deepEqual((facts.context as { appEnvAuthSelectors: string[] }).appEnvAuthSelectors, [], 'An ambient auth selector could substitute another account')
    const first = await app.firstWindow()
    first.setDefaultTimeout(20_000)
    return first
  })
  await openProject(page, project, 'W13 hook proof')

  const projectId = await step('selection: the project runs on the borrowed account', async () => {
    const selected = await page.evaluate(async (path) => {
      const listed = await (await fetch('/api/projects')).json() as { data: Array<{ projectId?: string; path: string }> }
      const id = listed.data.find((entry) => entry.path === path)?.projectId
      if (!id) return undefined
      const choice = await (await fetch(`/api/projects/${id}/accounts`)).json() as { data: { selection: { claude: string } } }
      return { id, claude: choice.data.selection.claude }
    }, project)
    assert.equal(selected?.claude, accountId, 'The disposable project did not select the borrowed account')
    return selected.id
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

  if (scenario === 'memory') {
    await step('memory selection: the default profile memory is chosen for this project', async () => {
      const offered = await page.evaluate(async (id) => (await (await fetch(`/api/projects/${id}/native-memory`)).json()).data, projectId) as
        { sources: Array<{ accountId: string; available: boolean }> }
      assert.ok(offered.sources.some((row) => row.accountId === 'default-claude' && row.available), 'The synthetic default memory is not on offer')
      const chosen = await apiPost(page, `/api/projects/${projectId}/native-memory`, { sourceAccountId: 'default-claude' }) as
        { data?: { selection: { writePolicy: string; destinationAccountId: string } }; error?: string }
      assert.ok(chosen.data, chosen.error ?? 'Selection failed')
      // Another account's memory: shared for reading, never promoted automatically.
      assert.equal(chosen.data.selection.writePolicy, 'review')
      assert.equal(chosen.data.selection.destinationAccountId, accountId)
    })
    const prompt = 'What is the handoff word for this project? Reply with only the word. Do not use tools.'
    assert.ok(!prompt.includes(memoryMarker))
    const seen = await step('turn: one no-tools model turn completes', async () => {
      const created = await apiPost(page, '/api/threads', { projectPath: project, text: prompt,
        settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'off', mcpSetup: 'off' } }) as
        { data?: { id: string }; error?: string }
      assert.ok(created.data?.id, created.error ?? 'Thread creation failed')
      let rows: Array<{ kind: string; text?: string; ok?: boolean; name?: string }> = []
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        rows = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data.events.map((row: { event: unknown }) => row.event), created.data.id)
        if (rows.some((event) => event.kind === 'result')) break
        await page.waitForTimeout(500)
      }
      // The marker is private: shared output records only whether it came back.
      for (const event of rows) output.push(`${event.kind}${event.name ? ` ${event.name}` : ''}${event.text ? `: ${event.text.replaceAll(memoryMarker, '<marker>').slice(0, 200)}` : ''}`)
      const result = rows.find((event) => event.kind === 'result')
      assert.equal(result?.ok, true, 'The packaged Claude turn did not succeed')
      assert.ok(!rows.some((event) => event.kind === 'tool_use'), 'The turn used a tool, so a file read could explain the answer')
      return rows
    })
    await step('memory: the reply carries the marker that exists only in the selected memory', () => {
      const replied = seen.some((event) => event.kind === 'assistant_text' && event.text?.includes(memoryMarker))
      facts.memory = { markerReturned: replied, markerInPrompt: false, writePolicy: 'review' }
      assert.ok(replied, 'Selected native memory did not reach the packaged Claude session')
    })
    verdict = 'passed'
  }
  if (scenario === 'skill') {
    await step('skill selection: the default profile skills are chosen for this project', async () => {
      const offered = await page.evaluate(async (id) => (await (await fetch(`/api/projects/${id}/skills`)).json()).data, projectId) as
        { offered: { skills: string[] } | null }
      assert.deepEqual(offered.offered?.skills, ['w13-proof-skill'], 'The synthetic skill is not on offer')
      const chosen = await apiPost(page, `/api/projects/${projectId}/skills`, { sourceAccountId: 'default-claude' }) as
        { data?: { selection: { destinationAccountId: string; counts: { skills: number } } }; error?: string }
      assert.ok(chosen.data, chosen.error ?? 'Selection failed')
      assert.equal(chosen.data.selection.destinationAccountId, accountId)
      assert.equal(chosen.data.selection.counts.skills, 1)
    })
    const invocation = '/w13-proof-skill banana'
    const seen = await step('turn: the bare skill name runs in one no-tools turn', async () => {
      const created = await apiPost(page, '/api/threads', { projectPath: project, text: invocation,
        settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'off', mcpSetup: 'off' } }) as
        { data?: { id: string }; error?: string }
      assert.ok(created.data?.id, created.error ?? 'Thread creation failed')
      let rows: Array<{ kind: string; text?: string; ok?: boolean; name?: string }> = []
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        rows = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data.events.map((row: { event: unknown }) => row.event), created.data.id)
        if (rows.some((event) => event.kind === 'result')) break
        await page.waitForTimeout(500)
      }
      for (const event of rows) output.push(`${event.kind}${event.name ? ` ${event.name}` : ''}${event.text ? `: ${event.text.replaceAll(skillMarker, '<marker>').slice(0, 200)}` : ''}`)
      const result = rows.find((event) => event.kind === 'result')
      assert.equal(result?.ok, true, 'The packaged Claude turn did not succeed')
      assert.ok(!rows.some((event) => event.kind === 'tool_use'), 'The turn used a tool')
      return rows
    })
    await step('skill: the reply carries the marker that exists only in the projected skill', () => {
      const replied = seen.some((event) => event.kind === 'assistant_text' && event.text?.includes(`${skillMarker}|banana`))
      facts.skill = { markerAndArgumentReturned: replied, invokedByBareName: true }
      assert.ok(replied, 'The projected skill did not run in the packaged Claude session')
    })
    verdict = 'passed'
  }
  if (scenario === 'policy') {
    await step('hook review: exactly the one synthetic PreToolUse hook, approved, hooks on', async () => {
      const found = await page.evaluate(async (path) => (await (await fetch(`/api/projects/claude-hooks?path=${encodeURIComponent(path)}`)).json()).data,
        project) as { revision: string; review: Array<{ event: string; referencedFiles: Array<{ hash: string }> }>; unavailable: unknown[] }
      assert.equal(found.review.length, 1, `Expected only the synthetic hook, found ${found.review.length}`)
      assert.equal(found.review[0]?.event, 'PreToolUse')
      assert.equal(found.review[0]?.referencedFiles[0]?.hash, hash(policyScript))
      assert.deepEqual(found.unavailable, [])
      await apiPost(page, '/api/projects/claude-hooks', { path: project, revision: found.revision })
      await apiPost(page, '/api/projects', { path: project, claudeHooks: true, claudeMcp: false })
    })
    const sanitize = (text: string): string => text.replaceAll(root!, '<root>')
    const writeTurn = async (mode: 'allow' | 'fail' | 'hang') => {
      writeFileSync(policyMode, mode)
      const target = join(project, `protected-${mode}.txt`)
      const created = await apiPost(page, '/api/threads', { projectPath: project,
        text: `Use the Write tool to create the file ${target} containing exactly OK. Do not use any other tool. If the Write tool is blocked, do not retry: reply BLOCKED. Otherwise reply DONE.`,
        settings: { agent: 'claude', model: 'haiku', permissionMode: 'acceptEdits', hooksSetup: 'inherit', mcpSetup: 'off' } }) as
        { data?: { id: string }; error?: string }
      assert.ok(created.data?.id, created.error ?? 'Thread creation failed')
      let rows: Array<{ kind: string; text?: string; ok?: boolean; name?: string }> = []
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        rows = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data.events.map((row: { event: unknown }) => row.event), created.data.id)
        if (rows.some((event) => event.kind === 'result')) break
        await page.waitForTimeout(500)
      }
      output.push(`--- ${mode}`)
      for (const event of rows) output.push(sanitize(`${event.kind}${event.name ? ` ${event.name}` : ''}${event.text ? `: ${event.text.slice(0, 240)}` : ''}`))
      const result = rows.find((event) => event.kind === 'result')
      assert.ok(result, `The ${mode} turn did not finish`)
      assert.ok(!(result.text ?? '').includes('Not logged in'), 'The borrowed Claude profile did not authenticate. Stop: no sign-in, no account switch, no retry')
      // The hung hook would allow after 30 s: wait past that before deciding nothing was written.
      if (mode === 'hang') await page.waitForTimeout(31_000)
      const log = existsSync(policyLog) ? readFileSync(policyLog, 'utf8') : ''
      return { written: existsSync(target), content: existsSync(target) ? readFileSync(target, 'utf8') : undefined,
        hookRan: log.split('\n').some((line) => line.startsWith(`${mode} `)), transcript: JSON.stringify(rows) }
    }
    const allow = await step('control: the hook allows, and the Write happens', async () => {
      const seen = await writeTurn('allow')
      assert.ok(seen.hookRan, 'The approved PreToolUse hook did not run')
      assert.ok(seen.written && seen.content?.trim() === 'OK', 'The Write did not happen, so a block later would prove nothing')
      return seen
    })
    const fail = await step('policy: the hook fails (exit 1), and the Write does not happen', async () => {
      const seen = await writeTurn('fail')
      assert.ok(seen.hookRan, 'The hook did not run')
      assert.equal(seen.written, false, 'A failing policy hook let the Write through')
      assert.ok(seen.transcript.includes('policy hook failed with exit code 1'), 'No denial reason reached the conversation')
      return seen
    })
    const hang = await step('policy: the hook hangs past its 3 s timeout, and the Write does not happen', async () => {
      const seen = await writeTurn('hang')
      assert.ok(seen.hookRan, 'The hook did not run')
      assert.equal(seen.written, false, 'A hung policy hook let the Write through')
      assert.ok(seen.transcript.includes('did not answer within 3 seconds'), 'No timeout denial reached the conversation')
      return seen
    })
    facts.policy = { control: { hookRan: allow.hookRan, written: allow.written }, fail: { hookRan: fail.hookRan, written: fail.written },
      hang: { hookRan: hang.hookRan, written: hang.written, waitedPastHookAllow: true }, hookSourceHash: hash(policyScript) }
    verdict = 'passed'
  }
  if (scenario === 'hooks') {
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
  }
} catch (error) {
  console.error(`[w13-u1] stopped: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  // Nothing under root links to the real profile, so removing it cannot reach the login.
  if (root) rmSync(root, { recursive: true, force: true })
  writeFileSync(join(evidence, 'output.txt'), `${output.join('\n')}\n`, { mode: 0o600 })
  writeJson(evidence, 'provider-context.json', { context: facts.context, identityPreflight: facts.identityPreflight, ...(facts.memory ? { memory: facts.memory } : {}), ...(facts.skill ? { skill: facts.skill } : {}), ...(facts.policy ? { policy: facts.policy } : {}) })
  const files = ['package-manifest.json', 'provider-context.json', 'output.txt'].filter((name) => existsSync(join(evidence, name)))
  writeJson(evidence, 'receipt.json', {
    scenario: { memory: 'W13-U5 packaged borrowed-account native memory proof', skill: 'W13-U6 packaged borrowed-account projected skill proof',
      hooks: 'W13-U1 packaged borrowed-account hook proof', policy: 'W13-U3c packaged borrowed-account policy hook denial proof' }[scenario], startedAt, finishedAt: new Date().toISOString(), source,
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
