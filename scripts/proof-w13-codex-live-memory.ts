// Real-provider native memory proof. Owned storage/runtime; no automatic memory worker, subagent or connector.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { isolatedMemoryThreadConfig, nativeMemoryProgram, nativeMemorySnapshot, nativeMemoryTrace } from './lib/w13-native-memory-overlay.ts'

process.umask(0o077)
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const profileBinding = process.env.COCKPIT_PROOF_PROFILE_BINDING ?? '', version = process.env.COCKPIT_W13_MEMORY_VERSION ?? 'v1'
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt: Record<string, unknown> = { scenario: 'real-provider-native-memory-write-restart-read', verdict: 'BLOCKED',
  nativeInputs: 0, ownedProviderExits: 0, layer: 'uninstalled-source-candidate-real-provider', phases: [] }
let attempt: ProbeAttempt | undefined, finalGuard: (() => void) | undefined
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1'); assert.ok(['v1', 'v2'].includes(version))
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
  const root = join(memory, version === 'v1' ? 'memories' : 'memories_v2'); mkdirSync(root, { mode: 0o700 })
  const selected = `W13_LIVE_SELECTED_${randomUUID()}`, note = `W13_LIVE_PERSISTED_${randomUUID()}`
  const filename = `2026-10-19T00-00-00-live-${randomUUID()}.md`, noteFile = join(root, 'extensions/ad_hoc/notes', filename)
  const { writeFileSync } = await import('node:fs')
  const summary = join(root, 'memory_summary.md'); writeFileSync(summary, `v1\n${selected}\n`, { flag: 'wx', mode: 0o600 })
  const summaryHash = sha(summary), originalTrees = ['memories', 'memories_v2'].map((name) => {
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
    assert.equal(realpathSync(profile), saved.canonicalProfile); assert.equal(sha(summary), summaryHash)
    assert.equal(sha(cli), pin.providerExecutableSha256); assert.equal(sha(manifest), receipt.manifestSha256)
    assert.equal(sha(codeModeHost), pin.codeModeHost.executableSha256)
    for (const tree of originalTrees) assert.deepEqual(nativeMemorySnapshot(tree.path), tree.snapshot)
    for (const [path, state] of sourceGuards) assert.equal(sourceState(path), state)
  }
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(fileURLToPath(import.meta.url)); receipt.oracleSha256 = sha(join(worktree, 'scripts/lib/w13-native-memory-overlay.ts'))
  receipt.manifestSha256 = sha(manifest); receipt.candidateSource = pin.candidateSourceCommit; receipt.executableSha256 = sha(cli)
  receipt.codeModeHostSha256 = pin.codeModeHost.executableSha256
  receipt.memoryVersion = version; receipt.accountMode = current.mode; receipt.accountGeneration = current.generation
  receipt.workspaceScope = cwd === worktree ? 'worktree' : 'primary'; finalGuard = guard
  const env: Record<string, string> = { HOME: process.env.HOME!, TMPDIR: privateDir, PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' }
  for (const key of ['USER', 'LOGNAME']) if (process.env[key]) env[key] = process.env[key]!
  if (current.mode === 'managed') env.CODEX_HOME = profile
  const overrides = [`memories.root=${JSON.stringify(memory)}`, `sqlite_home=${JSON.stringify(sqlite)}`, `sqlite_backfill_root=${JSON.stringify(history)}`,
    `memories.version=${JSON.stringify(version)}`, 'memories.use_memories=true', 'memories.generate_memories=false', 'memories.dual_write=false',
    'memories.dedicated_tools=true', 'features.memories=true', 'features.hooks=false', 'features.apps=false', 'features.plugins=false',
    'features.shell_tool=false', 'features.js_repl=false', 'features.computer_use=false', 'features.browser_use_external=false', 'features.image_generation=false',
    'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.code_mode=true', 'approvals_reviewer="user"',
    'features.background_paginated_rollout_migration=false', 'features.local_thread_store_compression=false',
    'web_search="disabled"', 'check_for_update_on_startup=false']
  attempt.writePrivate('binding-private.json', JSON.stringify({ current, cwd, env, profile, memory, sqlite, history, root, filename, note, selected,
    originalTrees, authBefore, overrides, profileBinding, bindingHash }, null, 2))
  let selectedModel: any
  for (const phase of ['write', 'read'] as const) {
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
      const init = await query('initialize', { clientInfo: { name: 'agent-cockpit-w13-live-memory', version: '1' }, capabilities: { experimentalApi: true } }, 15_000)
      assert.equal(realpathSync(init.codexHome), saved.canonicalProfile); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      await principal()
      const configResponse = await query('config/read', { cwd, includeLayers: true }), isolated = isolatedMemoryThreadConfig(configResponse)
      assert.equal(configResponse.config.memories?.root, memory); assert.equal(configResponse.config.sqlite_home, sqlite)
      assert.equal(configResponse.config.sqlite_backfill_root, history)
      assert.equal(configResponse.config.memories.use_memories, true); assert.equal(configResponse.config.memories.generate_memories, false)
      assert.equal(configResponse.config.memories.dedicated_tools, true); assert.equal(configResponse.config.memories.version, version)
      assert.ok(configResponse.config.features?.code_mode === true || configResponse.config.features?.code_mode?.enabled === true)
      assert.equal(configResponse.config.approvals_reviewer, 'user')
      for (const key of ['hooks', 'apps', 'plugins', 'shell_tool', 'js_repl', 'computer_use', 'browser_use_external', 'image_generation', 'background_paginated_rollout_migration', 'local_thread_store_compression']) assert.equal(configResponse.config.features?.[key], false)
      for (const path of isolated.sourceFiles) { const state = sourceState(path); if (sourceGuards.has(path)) assert.equal(state, sourceGuards.get(path)); else sourceGuards.set(path, state) }
      attempt.writePrivate(`${phase}-config-private.json`, JSON.stringify({ response: configResponse, threadOverrides: isolated.config, sourceGuards: Object.fromEntries(sourceGuards) }))
      const models = await query('model/list', { includeHidden: false }); assert.ok(Array.isArray(models.data) && models.data.length > 0)
      if (!selectedModel) selectedModel = models.data.find((model: any) => /mini|nano/i.test(model.model) && !model.hidden) ?? models.data.find((model: any) => model.isDefault)
      assert.ok(selectedModel && typeof selectedModel.model === 'string' && models.data.some((model: any) => model.model === selectedModel.model))
      const efforts = selectedModel.supportedReasoningEfforts?.map((row: any) => row.reasoningEffort) ?? []
      const effort = ['minimal', 'low', 'medium'].find((value) => efforts.includes(value)) ?? selectedModel.defaultReasoningEffort
      attempt.writePrivate(`${phase}-models-private.json`, JSON.stringify({ response: models, selectedModel, effort }))
      guard()
      const thread = await query('thread/start', { cwd, ephemeral: true, model: selectedModel.model, approvalPolicy: 'never', sandbox: 'read-only', config: isolated.config, experimentalRawEvents: true })
      const threadId = thread.thread?.id; assert.ok(typeof threadId === 'string' && threadId)
      const prompt = `This is an authorized synthetic native-memory ${phase} test. Use the native exec tool exactly once with the following exact JavaScript source, without adding imports, wrappers, other calls or helper agents. Then reply DONE.\n${nativeMemoryProgram(phase, filename, note)}`
      receipt.nativeInputs = Number(receipt.nativeInputs) + 1
      const turn = await query('turn/start', { threadId, input: [{ type: 'text', text: prompt }], effort })
      const end = await Promise.race([completed, failed]); assert.equal(end.threadId, threadId); assert.equal(end.turn?.id, turn.turn?.id)
      assert.equal(end.turn.status, 'completed', 'Native live turn did not complete successfully')
      const events = raw.filter((event) => event.turnId === turn.turn.id)
      const observation = nativeMemoryTrace(events, threadId, turn.turn.id, phase, filename, note)
      assert.equal(readFileSync(noteFile, 'utf8'), note); await principal(); guard()
      attempt.writePrivate(`${phase}-raw-items-private.json`, JSON.stringify({ threadId, turnId: turn.turn.id, raw, observation }))
      ;(receipt.phases as unknown[]).push({ phase, exactNativeCallAndResultObserved: true, nativeRawItems: observation.itemCount,
        route: observation.route,
        activePrincipalMatchedBeforeAndAfter: true, noteFileBytesMatched: true, selectedCanaryInRawItems: JSON.stringify(events).includes(selected) })
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
  receipt.verdict = 'PASS_REAL_PROVIDER_NATIVE_MEMORY_WRITE_RESTART_READ'
} catch (error) {
  process.exitCode = 1; attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown live failure')
} finally {
  try { finalGuard?.() } catch (error) { process.exitCode = 1; receipt.verdict = 'BLOCKED'; attempt?.writePrivate('guard-error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Guard failed') }
  receipt.limitations = ['Uninstalled native source candidate; not packaged/installed/production qualification',
    'Exact native ad-hoc note tool and new-process read; no automatic generation, promotion, concurrency or complete lifecycle proof',
    'Owned provider exit is counted; code-mode companion descendant retirement and cancellation remain unqualified',
    'Normal native token rotation may occur at the original locator, but active principal must match before and after each phase; host never reads auth.json payloads',
    'Original-memory symlink targets are not traversed by snapshot guards']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, nativeInputs: receipt.nativeInputs, ownedProviderExits: receipt.ownedProviderExits }))
}
