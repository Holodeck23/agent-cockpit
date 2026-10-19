// One real-provider typed skill/resource case. Process-local roots; original credential locator unchanged.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { isolatedMemoryThreadConfig, nativeMemorySnapshot } from './lib/w13-native-memory-overlay.ts'

import { nativeSkillProgram, nativeSkillTrace } from './lib/w13-live-skill.ts'
import { linkedSkillTemplate, nativeLinkedSkillTrace } from './lib/w13-linked-skill.ts'

process.umask(0o077)
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const profileBinding = process.env.COCKPIT_PROOF_PROFILE_BINDING ?? ''
const pathMode = process.env.COCKPIT_W13_SKILL_PATH_MODE ?? 'direct'
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt: Record<string, unknown> = { scenario: 'real-provider-native-typed-skill-resource', verdict: 'BLOCKED',
  startedAt: new Date().toISOString(), nativeInputs: 0, ownedProviderExits: 0, layer: 'uninstalled-source-candidate-real-provider', phases: [] }
let attempt: ProbeAttempt | undefined, finalGuard: (() => void) | undefined
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(['direct', 'linked'].includes(pathMode))
  if (pathMode === 'linked') receipt.scenario = 'real-provider-linked-skill-canonical-discovery-resource'
  assert.ok([cli, evidence, privateDir, profileBinding].every(isAbsolute))
  const privateRoot = realpathSync(join(process.env.HOME!, 'vault/clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot) && realpathSync(profileBinding).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  const worktree = dirname(dirname(fileURLToPath(import.meta.url))), manifest = join(worktree, 'vendor/codex-memory-root/upstream.json')
  const pin = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(pin.candidateSourceCommit, '9e8562bd9e4785ffa855d33b6b112c9ba22910a6'); assert.equal(pin.candidateBuilt, true)
  assert.equal(sha(cli), pin.providerExecutableSha256)
  const codeModeHost = join(dirname(cli), 'codex-code-mode-host')
  assert.ok(pin.codeModeHost?.executableSha256 && existsSync(codeModeHost), 'Live code-mode companion must be built and pinned before any model input')
  assert.equal(sha(codeModeHost), pin.codeModeHost.executableSha256)
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const saved = JSON.parse(readFileSync(profileBinding, 'utf8')), bindingHash = sha(profileBinding)
  const registry = join(process.env.HOME!, '.agent-cockpit/accounts.json'), registryHash = sha(registry)
  const current = JSON.parse(readFileSync(registry, 'utf8')).accounts.find((row: any) => row.id === saved.current.id)
  assert.deepEqual(current, saved.current); assert.ok(current.agent === 'codex' && current.identity?.state === 'known')
  const profile = current.mode === 'default' ? join(process.env.HOME!, '.codex') : join(process.env.HOME!, '.agent-cockpit/account-profiles', current.id)
  assert.equal(profile, saved.nativeCredentialHome); assert.equal(realpathSync(profile), saved.canonicalProfile)
  const cwd = saved.cwd; assert.ok([worktree, join(dirname(dirname(worktree)), 'agent-cockpit')].includes(cwd))
  const memory = join(privateDir, 'memory'), sqlite = join(privateDir, 'state'), history = join(privateDir, 'history')
  for (const path of [memory, sqlite, history]) mkdirSync(path, { mode: 0o700 })
  const roots = [join(privateDir, 'selected-skills'), join(privateDir, 'excluded-skills')]
  const selectedDir = join(pathMode === 'linked' ? join(privateDir, 'canonical-skills') : roots[0]!, 'w13-live-resource'), excludedDir = join(roots[1]!, 'w13-live-resource')
  for (const path of [selectedDir, excludedDir]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const discoveryDir = join(roots[0]!, 'w13-live-resource'), discoveryFile = join(discoveryDir, 'SKILL.md')
  if (pathMode === 'linked') { mkdirSync(roots[0]!, { mode: 0o700 }); symlinkSync(selectedDir, discoveryDir, 'dir') }
  const selected = `W13_SKILL_SELECTED_${randomUUID()}`, excluded = `W13_SKILL_EXCLUDED_${randomUUID()}`, resource = `W13_SKILL_RESOURCE_${randomUUID()}`
  const args = `  --label "two  words"\n--target W13_ARG_${randomUUID()}  `
  const selectedFile = join(selectedDir, 'SKILL.md'), excludedFile = join(excludedDir, 'SKILL.md')
  const header = '---\nname: w13-live-resource\ndescription: Owned W13 synthetic resource verification, explicit selection only.\n---\n'
  const programInstruction = pathMode === 'linked'
    ? `Resolve reference.txt relative to the directory of this skill's native <path> wrapper. In the following JavaScript replace only /W13_NATIVE_SKILL_DIRECTORY with that directory; preserve every other character. The host did not provide the resource root in this skill body.\n${linkedSkillTemplate()}`
    : nativeSkillProgram(selectedDir)
  writeFileSync(selectedFile, header + `This selected skill identity is ${selected}.\nFor this skill, use the native exec tool exactly once with this exact JavaScript source:\n${programInstruction}\nThen reply with a single JSON object, without Markdown: selected is this identity string; arguments is the exact string between BEGIN_ARGUMENTS and END_ARGUMENTS in user input (no delimiters or boundary newlines, preserve all other whitespace and quotes); resource is the content returned by the native read. Do not perform other tool calls or spawn helpers.\n`, { flag: 'wx', mode: 0o600 })
  if (pathMode === 'linked') assert.ok(!readFileSync(selectedFile, 'utf8').includes(selectedDir))
  writeFileSync(excludedFile, header + `This excluded same-name skill body is ${excluded}.\n`, { flag: 'wx', mode: 0o600 })
  writeFileSync(join(selectedDir, 'reference.txt'), resource, { flag: 'wx', mode: 0o600 })
  writeFileSync(join(excludedDir, 'reference.txt'), excluded, { flag: 'wx', mode: 0o600 })
  const originalTrees = ['memories', 'memories_v2'].map((name) => {
    const path = join(profile, name); return { path, snapshot: nativeMemorySnapshot(path) }
  })
  const sourceGuards = new Map<string, string>()
  const sourceState = (path: string): string => existsSync(path) ? `${realpathSync(path)}:${sha(path)}` : 'absent'
  const authMetadata = (): unknown => {
    const file = join(profile, 'auth.json'); if (!existsSync(file)) return null
    const stat = lstatSync(file); return { device: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }
  }
  const authBefore = authMetadata()
  const guard = (): void => {
    assert.equal(sha(registry), registryHash); assert.equal(sha(profileBinding), bindingHash)
    assert.equal(realpathSync(profile), saved.canonicalProfile)
    assert.equal(sha(cli), pin.providerExecutableSha256); assert.equal(sha(manifest), receipt.manifestSha256)
    assert.equal(sha(codeModeHost), pin.codeModeHost.executableSha256)
    if (pathMode === 'linked') {
      assert.ok(lstatSync(discoveryDir).isSymbolicLink()); assert.equal(readlinkSync(discoveryDir), selectedDir)
      assert.equal(realpathSync(discoveryFile), selectedFile)
    }
    for (const tree of originalTrees) assert.deepEqual(nativeMemorySnapshot(tree.path), tree.snapshot)
    for (const [path, state] of sourceGuards) assert.equal(sourceState(path), state)
  }
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(fileURLToPath(import.meta.url)); receipt.oracleSha256 = sha(join(worktree, 'scripts/lib/w13-live-skill.ts'))
  receipt.manifestSha256 = sha(manifest); receipt.candidateSource = pin.candidateSourceCommit; receipt.executableSha256 = sha(cli)
  receipt.codeModeHostSha256 = pin.codeModeHost.executableSha256
  receipt.skillPathMode = pathMode
  if (pathMode === 'linked') receipt.linkedOracleSha256 = sha(join(worktree, 'scripts/lib/w13-linked-skill.ts'))
  receipt.accountMode = current.mode; receipt.accountGeneration = current.generation
  receipt.workspaceScope = cwd === worktree ? 'worktree' : 'primary'; finalGuard = guard
  const env: Record<string, string> = { HOME: process.env.HOME!, TMPDIR: privateDir, PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' }
  for (const key of ['USER', 'LOGNAME']) if (process.env[key]) env[key] = process.env[key]!
  if (current.mode === 'managed') env.CODEX_HOME = profile
  const overrides = [`memories.root=${JSON.stringify(memory)}`, `sqlite_home=${JSON.stringify(sqlite)}`, `sqlite_backfill_root=${JSON.stringify(history)}`,
    'memories.use_memories=false', 'memories.generate_memories=false', 'memories.dual_write=false',
    'memories.dedicated_tools=true', 'features.memories=false', 'features.hooks=false', 'features.apps=false', 'features.plugins=false',
    'features.shell_tool=true', 'features.unified_exec=true', 'features.js_repl=false', 'features.computer_use=false', 'features.browser_use_external=false', 'features.image_generation=false',
    'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.code_mode=true', 'approvals_reviewer="user"',
    'features.background_paginated_rollout_migration=false', 'features.local_thread_store_compression=false',
    'web_search="disabled"', 'check_for_update_on_startup=false']
  attempt.writePrivate('binding-private.json', JSON.stringify({ current, cwd, env, profile, memory, sqlite, history, roots, selectedDir, discoveryDir, discoveryFile, selected, excluded, resource, args,
    originalTrees, authBefore, overrides, profileBinding, bindingHash }, null, 2))
  let selectedModel: any
  const nativeThreads = new Set<string>()
  for (const phase of pathMode === 'linked' ? ['canonical', 'discovery'] : ['skill']) {
    guard(); const output = new ProbeOutput(), raw: any[] = []
    const child = spawn(cli, [...overrides.flatMap((value) => ['-c', value]), 'app-server', '--strict-config'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let finished = false, exited = false, sequence = 0, failure: Error | undefined
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    let rejectFailure!: (error: Error) => void, completeTurn!: (value: any) => void
    const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject }); void failed.catch(() => {})
    const completed = new Promise<any>((resolve) => { completeTurn = resolve })
    const stop = (error: Error): void => {
      if (finished || failure) return
      failure = error; for (const query of pending.values()) { clearTimeout(query.timer); query.reject(error) }; pending.clear()
      rejectFailure(error); if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    const closed = new Promise<void>((resolve) => child.once('close', () => { exited = true; if (!finished) stop(new Error('Owned live provider exited before proof completion')); resolve() }))
    const total = setTimeout(() => stop(new Error('Live native launch exceeded 60 seconds')), 60_000)
    child.once('error', () => stop(new Error('Owned live provider could not start')))
    child.stdin.on('error', () => stop(new Error('Live provider protocol input closed')))
    for (const channel of ['stdout', 'stderr'] as const) child[channel].on('data', (chunk: Buffer) => { try { output.append(channel, chunk) } catch { stop(new Error('Live provider output exceeded byte limit')) } })
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line)
        assert.ok(!(message.method && message.id !== undefined), 'Unexpected native approval/control request')
        if (message.id !== undefined) {
          const query = pending.get(message.id); assert.ok(query, 'Unexpected native response ID'); pending.delete(message.id); clearTimeout(query.timer)
          if (message.error) query.reject(new Error(`Native request rejected with code ${String(message.error.code)}`)); else query.resolve(message.result)
        } else if (message.method === 'rawResponseItem/completed') { assert.ok(raw.length < 256); raw.push(message.params) }
        else if (message.method === 'turn/completed') completeTurn(message.params)
        else if (message.method === 'error') stop(new Error('Native live provider reported an error; inspect private receipt without retry'))
      } catch (error) { stop(error instanceof Error ? error : new Error('Invalid live protocol')) }
    })
    const query = (method: string, params: unknown, timeout = 30_000): Promise<any> => {
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => stop(new Error(`Native ${method} readiness exceeded ${timeout / 1000} seconds`)), timeout)
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    }
    const principal = async (): Promise<void> => {
      const result = await query('account/read', { refreshToken: false }); const identity = codexIdentityFrom(result)
      assert.ok(result.requiresOpenaiAuth === true && identity.state === 'known' && identity.key === current.identity.key, 'Active native-provider principal mismatch; stop without refresh or fallback')
      attempt!.writePrivate(`${phase}-account-${sequence}-private.json`, JSON.stringify({ response: result, identity }))
    }
    try {
      const init = await query('initialize', { clientInfo: { name: 'agent-cockpit-w13-live-skill', version: '1' }, capabilities: { experimentalApi: true } }, 15_000)
      assert.equal(realpathSync(init.codexHome), saved.canonicalProfile); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      await principal()
      const configResponse = await query('config/read', { cwd, includeLayers: true }), isolated = isolatedMemoryThreadConfig(configResponse)
      assert.equal(configResponse.config.memories?.root, memory); assert.equal(configResponse.config.sqlite_home, sqlite)
      assert.equal(configResponse.config.sqlite_backfill_root, history)
      assert.equal(configResponse.config.memories.use_memories, false); assert.equal(configResponse.config.memories.generate_memories, false)
      assert.equal(configResponse.config.memories.dedicated_tools, true)
      assert.ok(configResponse.config.features?.code_mode === true || configResponse.config.features?.code_mode?.enabled === true)
      assert.equal(configResponse.config.approvals_reviewer, 'user')
      for (const key of ['hooks', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'memories', 'js_repl', 'computer_use', 'browser_use_external', 'image_generation', 'background_paginated_rollout_migration', 'local_thread_store_compression']) assert.equal(configResponse.config.features?.[key], false)
      assert.equal(configResponse.config.features?.shell_tool, true); assert.equal(configResponse.config.features?.unified_exec, true)
      for (const path of isolated.sourceFiles) { const state = sourceState(path); if (sourceGuards.has(path)) assert.equal(state, sourceGuards.get(path)); else sourceGuards.set(path, state) }
      attempt.writePrivate(`${phase}-config-private.json`, JSON.stringify({ response: configResponse, threadOverrides: isolated.config, sourceGuards: Object.fromEntries(sourceGuards) }))
      const models = await query('model/list', { includeHidden: false }); assert.ok(Array.isArray(models.data) && models.data.length > 0)
      if (!selectedModel) selectedModel = models.data.find((model: any) => /mini|nano/i.test(model.model) && !model.hidden) ?? models.data.find((model: any) => model.isDefault)
      assert.ok(selectedModel && typeof selectedModel.model === 'string' && models.data.some((model: any) => model.model === selectedModel.model))
      const efforts = selectedModel.supportedReasoningEfforts?.map((row: any) => row.reasoningEffort) ?? []
      const effort = ['minimal', 'low', 'medium'].find((value) => efforts.includes(value)) ?? selectedModel.defaultReasoningEffort
      receipt.model = selectedModel.model; receipt.effort = effort
      attempt.writePrivate(`${phase}-models-private.json`, JSON.stringify({ response: models, selectedModel, effort }))
      guard()
      // Native process-local discovery roots: no profile/project installation or config write.
      await query('skills/extraRoots/set', { extraRoots: roots })
      const catalog = await query('skills/list', { cwds: [cwd], forceReload: true })
      const entries = catalog.data; assert.ok(Array.isArray(entries) && entries.length === 1 && entries[0].errors.length === 0)
      const skills = entries[0].skills; assert.ok(Array.isArray(skills))
      const pathOf = (path: string): string => realpathSync(path.startsWith('file://') ? fileURLToPath(path) : path)
      const selectedRows = skills.filter((row: any) => pathOf(row.path) === selectedFile)
      const excludedRows = skills.filter((row: any) => pathOf(row.path) === excludedFile)
      assert.equal(selectedRows.length, 1); assert.equal(excludedRows.length, 1)
      const chosen = selectedRows[0]; assert.equal(chosen.name, 'w13-live-resource'); assert.equal(chosen.enabled, true)
      assert.equal(excludedRows[0].name, chosen.name); assert.equal(excludedRows[0].enabled, true)
      // Only these two synthetic sources stay enabled for this thread. Keep the collision visible.
      isolated.config.skills = { config: skills.filter((row: any) => ![selectedFile, excludedFile].includes(pathOf(row.path)))
        .map((row: any) => ({ path: pathOf(row.path), enabled: false })) }
      for (const path of [selectedFile, excludedFile, join(selectedDir, 'reference.txt'), join(excludedDir, 'reference.txt')]) {
        const state = sourceState(path)
        if (sourceGuards.has(path)) assert.equal(state, sourceGuards.get(path), 'Linked fixture changed between phases')
        else sourceGuards.set(path, state)
      }
      attempt.writePrivate(`${phase}-skill-catalog-private.json`, JSON.stringify({ catalog, threadConfig: isolated.config }))
      guard(); await principal()
      const thread = await query('thread/start', { cwd, ephemeral: true, model: selectedModel.model, approvalPolicy: 'never', sandbox: 'read-only', config: isolated.config, experimentalRawEvents: true })
      const threadId = thread.thread?.id; assert.ok(typeof threadId === 'string' && threadId)
      assert.ok(!nativeThreads.has(threadId), 'Each path phase requires a fresh native thread'); nativeThreads.add(threadId)
      const prompt = `This is an authorized bounded synthetic skill test. Apply the explicitly selected skill. No helper agents.\nBEGIN_ARGUMENTS\n${args}\nEND_ARGUMENTS`
      for (const marker of [selected, excluded, resource]) assert.ok(!prompt.includes(marker))
      const typedPath = pathMode === 'linked' ? (phase === 'discovery' ? discoveryFile : selectedFile) : chosen.path
      attempt.writePrivate(`${phase}-native-input-private.json`, JSON.stringify({ threadId, prompt, chosen, typedPath }))
      receipt.nativeInputs = Number(receipt.nativeInputs) + 1
      const turn = await query('turn/start', { threadId, input: [{ type: 'skill', name: chosen.name, path: typedPath }, { type: 'text', text: prompt }], effort })
      const end = await Promise.race([completed, failed]); assert.equal(end.threadId, threadId); assert.equal(end.turn?.id, turn.turn?.id)
      assert.equal(end.turn.status, 'completed', 'Native live turn did not complete successfully')
      const events = raw.filter((event) => event.turnId === turn.turn.id)
      attempt.writePrivate(`${phase}-raw-items-private.json`, JSON.stringify({ threadId, turnId: turn.turn.id, raw }))
      const expected = { selectedDir, selected, excluded, resource, args, discoveryFile }
      const observation = pathMode === 'linked' ? nativeLinkedSkillTrace(events, threadId, turn.turn.id, expected)
        : nativeSkillTrace(events, threadId, turn.turn.id, expected)
      assert.equal(readFileSync(join(selectedDir, 'reference.txt'), 'utf8'), resource); await principal(); guard()
      ;(receipt.phases as unknown[]).push({ phase, typedSelectionLoadedInNativeInput: true, exactArgumentsInNativeInputAndBehavior: true,
        ...(pathMode === 'linked' ? { nativeCanonicalPathObserved: true, resourceRootDerivedFromNativePath: true, linkedAliasGuardPassed: true } : {}),
        exactNativeResourceCallAndResult: true, excludedSourceCanaryAbsent: true, distinctSameNameSourcesDiscovered: true,
        activePrincipalMatchedBeforeAndAfter: true, nativeRawItems: observation.itemCount })
    } finally {
      finished = true; clearTimeout(total)
      for (const item of pending.values()) clearTimeout(item.timer)
      if (!exited && child.pid) child.kill('SIGKILL')
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); reject(new Error('Owned live provider retirement uncertain')) }, 5_000) })]) }
      finally { clearTimeout(timer); attempt.writePrivate(`${phase}-provider-stream-private.txt`, output.snapshot()) }
      if (exited) receipt.ownedProviderExits = Number(receipt.ownedProviderExits) + 1
    }
  }
  attempt.writePrivate('auth-metadata-after-private.json', JSON.stringify({ before: authBefore, after: authMetadata(), nativeTokenRefreshPermittedOnlyWithSameObservedPrincipal: true }))
  receipt.verdict = pathMode === 'linked' ? 'PASS_REAL_PROVIDER_LINKED_SKILL_CANONICAL_AND_DISCOVERY_PATHS' : 'PASS_ONE_REAL_PROVIDER_NATIVE_TYPED_SKILL_RESOURCE'
} catch (error) {
  process.exitCode = 1; attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown live failure')
} finally {
  try { finalGuard?.() } catch (error) { process.exitCode = 1; receipt.verdict = 'BLOCKED'; attempt?.writePrivate('guard-error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Guard failed') }
  receipt.limitations = ['Uninstalled native source candidate; not packaged/installed/production qualification',
    pathMode === 'linked' ? 'One account/workspace canonical/discovery pair with owned linked synthetic source; no full catalog, instruction-precedence or lifecycle qualification'
      : 'One account/workspace initial-turn case with two process-local synthetic roots; no linked-skill or precedence/lifecycle matrix qualification',
    'Owned provider exit is counted; code-mode companion descendant retirement and cancellation remain unqualified',
    'Normal native token rotation may occur at the original locator, but active principal must match before and after each phase; host never reads auth.json payloads',
    'Original-memory symlink targets are not traversed by snapshot guards']
  receipt.finishedAt = new Date().toISOString()
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, nativeInputs: receipt.nativeInputs, ownedProviderExits: receipt.ownedProviderExits }))
}
