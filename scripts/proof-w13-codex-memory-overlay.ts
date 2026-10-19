// Separate source-candidate mechanism proof. Original credential locators; loopback model; no worker.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { assessNativeMemoryRequest } from './lib/w13-memory-request.ts'
import { isolatedMemoryThreadConfig, nativeMemoryCall, nativeMemoryResult } from './lib/w13-native-memory-overlay.ts'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'

process.umask(0o077)
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const version = process.env.COCKPIT_W13_MEMORY_VERSION ?? 'v1', scope = process.env.COCKPIT_W13_FIXTURE_WORKSPACE ?? 'primary'
const accountMode = process.env.COCKPIT_W13_ACCOUNT_MODE, realAccount = accountMode !== undefined
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt: Record<string, unknown> = { scenario: 'native-codex-selected-overlay-note-write-restart-read',
  startedAt: new Date().toISOString(), verdict: 'BLOCKED', layer: 'source-candidate-native-cli-loopback-model',
  accountScope: realAccount ? 'real-native-profile-private-binding-controlled-model' : 'fictional-fixed-credential-locator',
  remoteModelRequests: 0, loopbackRequests: 0, nativeInputs: 0, ownedProviderExits: 0 }
const output = new ProbeOutput(), server = createServer()
let attempt: ProbeAttempt | undefined, phase: 'write' | 'read' = 'write', requestCount = 0
let failPhase: ((error: Error) => void) | undefined
let verifyAccountEnd: (() => void) | undefined
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(['v1', 'v2'].includes(version) && ['primary', 'worktree'].includes(scope))
  assert.ok(!realAccount || ['default', 'managed'].includes(accountMode!))
  assert.ok([cli, evidence, privateDir].every(isAbsolute))
  assert.ok(realpathSync(dirname(privateDir)).startsWith(realpathSync(join(process.env.HOME!, 'vault/clients')) + sep))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const manifest = join(repo, 'vendor/codex-memory-root/upstream.json')
  const pin = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(pin.candidateBuilt, true, 'Candidate build must be verified and pinned before this probe')
  assert.equal(pin.candidateSourceCommit, '9e8562bd9e4785ffa855d33b6b112c9ba22910a6')
  assert.match(pin.providerExecutableSha256, /^[a-f0-9]{64}$/)
  assert.equal(sha(cli), pin.providerExecutableSha256)
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  assert.ok(!['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist', join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')].some(existsSync))
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(fileURLToPath(import.meta.url))
  receipt.oracleSha256 = sha(join(repo, 'scripts/lib/w13-native-memory-overlay.ts'))
  receipt.provider = { executableSha256: sha(cli), sourceCommit: pin.candidateSourceCommit, version: pin.providerVersionObserved, manifestSha256: sha(manifest) }
  receipt.memoryVersion = version; receipt.fixtureWorkspaceScope = scope
  const home = realAccount ? process.env.HOME! : join(privateDir, 'home'), credentialHome = join(privateDir, 'credential-home'), memoryBase = join(privateDir, 'selected-base')
  const sqliteHome = join(privateDir, 'selected-state'), otherBase = join(privateDir, 'unselected-base'), project = join(privateDir, 'project')
  const backfillRoot = join(privateDir, 'selected-history')
  for (const path of [...(realAccount ? [] : [home]), credentialHome, memoryBase, sqliteHome, backfillRoot, otherBase, project]) mkdirSync(path, { mode: 0o700 })
  const gitEnv = { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  if (!realAccount) execFileSync('/usr/bin/git', ['init', '-q', project], { env: gitEnv, timeout: 10_000 })
  let cwd = project
  if (!realAccount && scope === 'worktree') {
    execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=W13 fixture', '-c', 'user.email=w13@example.invalid', 'commit', '--allow-empty', '-qm', 'Owned fixture baseline'], { env: gitEnv, timeout: 10_000 })
    cwd = join(privateDir, 'worktree')
    execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'w13-fixture', cwd], { env: gitEnv, timeout: 10_000 })
  }
  let nativeCredentialHome = credentialHome, current: any, registry = '', registryHash = '', canonicalProfile = ''
  let identityPreflightFile = '', identityPreflightHash = ''
  const authMetadata = (): unknown => {
    const file = join(nativeCredentialHome, 'auth.json')
    if (!existsSync(file)) return null
    const stat = lstatSync(file); return { device: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }
  }
  if (realAccount) {
    const contextDir = process.env.COCKPIT_PROOF_CONTEXT ?? ''
    assert.ok(isAbsolute(contextDir) && realpathSync(contextDir).startsWith(realpathSync(join(home, 'vault/clients')) + sep))
    const saved = JSON.parse(readFileSync(join(contextDir, `codex-${accountMode}-${scope}-private.json`), 'utf8'))
    registry = join(home, '.agent-cockpit/accounts.json'); registryHash = sha(registry)
    current = JSON.parse(readFileSync(registry, 'utf8')).accounts.find((row: any) => row.id === saved.account.id)
    assert.deepEqual(current, saved.account); assert.equal(current.agent, 'codex'); assert.equal(current.mode, accountMode)
    assert.ok(current.identity?.state === 'known' && saved.identity.key === current.identity.key)
    nativeCredentialHome = accountMode === 'default' ? join(home, '.codex') : join(home, '.agent-cockpit/account-profiles', current.id)
    canonicalProfile = realpathSync(nativeCredentialHome)
    if (accountMode === 'managed') {
      assert.equal(current.isolation, 'CODEX_HOME'); assert.equal(saved.env.CODEX_HOME, nativeCredentialHome)
      assert.equal(saved.canonicalProfile, canonicalProfile)
    } else { assert.equal(current.isolation, 'none'); assert.equal(saved.env.CODEX_HOME, undefined) }
    cwd = scope === 'primary' ? join(dirname(dirname(repo)), 'agent-cockpit') : repo; assert.equal(saved.cwd, cwd)
    const preflightDir = process.env.COCKPIT_PROOF_IDENTITY_PREFLIGHT ?? ''
    assert.ok(isAbsolute(preflightDir) && realpathSync(preflightDir).startsWith(realpathSync(join(home, 'vault/clients')) + sep))
    identityPreflightFile = join(preflightDir, `${accountMode}-${scope}-binding-private.json`)
    identityPreflightHash = sha(identityPreflightFile)
    const preflight = JSON.parse(readFileSync(identityPreflightFile, 'utf8'))
    assert.deepEqual(preflight.current, current); assert.equal(preflight.cwd, cwd)
    assert.equal(preflight.literalProfile, nativeCredentialHome); assert.equal(preflight.canonicalProfile, canonicalProfile)
    const identity = codexIdentityFrom(preflight.accountResponse)
    assert.ok(identity.state === 'known' && identity.key === current.identity.key, 'Native-provider preflight principal mismatch')
    assert.deepEqual(preflight.authMetadataAfter, authMetadata())
    receipt.accountMode = accountMode; receipt.accountGeneration = current.generation
  }
  const authBefore = authMetadata()
  const directory = version === 'v1' ? 'memories' : 'memories_v2'
  const selected = `W13_SELECTED_ROOT_${randomUUID()}`, note = `W13_PERSISTED_NOTE_${randomUUID()}`
  const negatives: string[] = [], guards = new Map<string, string>()
  for (const base of [credentialHome, memoryBase, otherBase]) for (const name of ['memories', 'memories_v2']) {
    const root = join(base, name); mkdirSync(root, { mode: 0o700 })
    const marker = base === memoryBase && name === directory ? selected : `W13_NEGATIVE_ROOT_${randomUUID()}`
    if (marker !== selected) negatives.push(marker)
    const file = join(root, 'memory_summary.md')
    writeFileSync(file, `v1\n${marker}\n`, { flag: 'wx', mode: 0o600 }); guards.set(file, sha(file))
  }
  const locatorSentinel = join(credentialHome, 'fictional-credential-locator.txt')
  writeFileSync(locatorSentinel, 'Owned fixture locator; no actual authentication data.\n', { flag: 'wx', mode: 0o600 }); guards.set(locatorSentinel, sha(locatorSentinel))
  const filename = `2026-10-19T00-00-00-w13-${randomUUID()}.md`, relativeNote = `extensions/ad_hoc/notes/${filename}`
  const noteFile = join(memoryBase, directory, relativeNote)
  const snapshot = (root: string, prefix = ''): Record<string, string> => {
    const files: Record<string, string> = {}
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()), 'Unexpected memory fixture entry')
      const name = join(prefix, entry.name)
      if (entry.isDirectory()) { files[name + '/'] = 'directory'; Object.assign(files, snapshot(root, name)) }
      else files[name] = sha(join(root, name))
    }
    return files
  }
  const negativeTrees = [credentialHome, memoryBase, otherBase].flatMap((base) => ['memories', 'memories_v2']
    .filter((name) => base !== memoryBase || name !== directory).map((name) => { const root = join(base, name); return { root, files: snapshot(root) } }))
  const originalSnapshot = (root: string, prefix = '', depth = 0): Record<string, string> => {
    assert.ok(depth <= 12)
    const path = join(root, prefix)
    if (!existsSync(path)) return { [prefix]: 'absent' }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return { [prefix]: `untraversed-symlink:${readlinkSync(path)}` }
    if (stat.isFile()) return { [prefix]: sha(path) }
    assert.ok(stat.isDirectory())
    const entries = readdirSync(path); assert.ok(entries.length <= 4096)
    return Object.assign({ [prefix + '/']: 'directory' }, ...entries.map((name) => originalSnapshot(root, join(prefix, name), depth + 1)))
  }
  const originalTrees = realAccount ? ['memories', 'memories_v2'].map((name) => {
    const root = join(nativeCredentialHome, name); return { root, files: originalSnapshot(root) }
  }) : []
  const sourceGuards = new Map<string, { hash: string; canonical?: string }>()
  const sourceState = (file: string): { hash: string; canonical?: string } => existsSync(file) ? { hash: sha(file), canonical: realpathSync(file) } : { hash: 'absent' }
  const assertAccount = (): void => {
    if (!realAccount) return
    assert.equal(sha(registry), registryHash); assert.equal(realpathSync(nativeCredentialHome), canonicalProfile)
    assert.equal(sha(identityPreflightFile), identityPreflightHash)
    assert.deepEqual(authMetadata(), authBefore)
    for (const tree of originalTrees) assert.deepEqual(originalSnapshot(tree.root), tree.files)
    for (const [file, state] of sourceGuards) assert.deepEqual(sourceState(file), state)
  }
  verifyAccountEnd = assertAccount
  const providerName = realAccount ? `w13fixture_${randomUUID().replaceAll('-', '')}` : 'w13fixture'
  const prompt = 'Perform the single synthetic native memory operation supplied by this test. Do not use any other tool or start helpers.'
  const callId = (): string => `w13-native-${phase}`
  const sse = (response: import('node:http').ServerResponse, item: unknown): void => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`
      + `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`
      + `data: ${JSON.stringify({ type: 'response.completed', response: { id: `w13-${phase}-${requestCount}`, output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`)
  }
  server.on('request', (request, response) => {
    let size = 0; const chunks: Buffer[] = []
    const fail = (error: unknown): void => { response.destroy(); failPhase?.(error instanceof Error ? error : new Error('Invalid local model request')) }
    request.on('error', fail)
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) { request.destroy(); fail(new Error('Local model request exceeded byte limit')) } else chunks.push(chunk) })
    request.on('end', () => {
      try {
        assert.ok(request.method === 'POST' && request.url === '/v1/responses', 'Unexpected loopback HTTP route; stop without answering discovery')
        assert.ok(request.headers.authorization === undefined, 'Owned unauthenticated loopback provider sent an authorization header')
        assert.ok(++requestCount <= 2, 'Unexpected additional model request')
        receipt.loopbackRequests = Number(receipt.loopbackRequests) + 1
        const bytes = request.headers['content-encoding'] === 'gzip' ? gunzipSync(Buffer.concat(chunks), { maxOutputLength: 2_000_000 }) : Buffer.concat(chunks)
        attempt!.writePrivate(`${phase}-model-request-${requestCount}-private.json`, bytes)
        const body = JSON.parse(bytes.toString('utf8'))
        for (const excluded of negatives) assessNativeMemoryRequest(body, selected, excluded, prompt)
        if (requestCount === 1) {
          assert.ok(!JSON.stringify({ input: body.input, instructions: body.instructions }).includes(note), 'Note reached context before native retrieval')
          sse(response, nativeMemoryCall(body.tools, phase === 'write' ? 'add_ad_hoc_note' : 'read', callId(), phase === 'write'
            ? { filename, note } : { path: relativeNote, line_offset: 1, max_lines: 10 }))
        } else {
          nativeMemoryResult(body, callId(), phase === 'read' ? note : undefined)
          assert.equal(readFileSync(noteFile, 'utf8'), note, 'Native note write did not reach selected root')
          sse(response, { type: 'message', id: `w13-${phase}-done`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] })
        }
      } catch (error) { fail(error) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const catalogFile = join(privateDir, 'owned-model-catalog.json')
  if (realAccount) {
    writeFileSync(catalogFile, JSON.stringify({ models: [{ slug: 'w13-fixture', display_name: 'Owned loopback memory fixture',
      base_instructions: 'Execute only the single owned native memory tool operation. Do not start helpers or other tools.',
      supported_reasoning_levels: [], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 0,
      support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10_000 }, experimental_supported_tools: [],
      input_modalities: ['text'], context_window: 128_000 }] }), { flag: 'wx', mode: 0o600 })
    guards.set(catalogFile, sha(catalogFile))
  }
  const config = `model_provider="w13fixture"\nmodel="w13-fixture"\napproval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\ncheck_for_update_on_startup=false\nsqlite_home=${JSON.stringify(sqliteHome)}\nsqlite_backfill_root=${JSON.stringify(backfillRoot)}\n[features]\nmemories=true\nmulti_agent=false\nhooks=false\napps=false\nplugins=false\nshell_tool=false\nbackground_paginated_rollout_migration=false\nlocal_thread_store_compression=false\n[memories]\nroot=${JSON.stringify(memoryBase)}\nversion=${JSON.stringify(version)}\ndual_write=false\ngenerate_memories=false\nuse_memories=true\ndedicated_tools=true\n[model_providers.w13fixture]\nname="Owned loopback fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`
  const configFile = join(credentialHome, 'config.toml')
  const cliOverrides = realAccount ? [
    `model_provider=${JSON.stringify(providerName)}`, 'model="w13-fixture"', 'approval_policy="never"', 'sandbox_mode="read-only"',
    `model_catalog_json=${JSON.stringify(catalogFile)}`, 'features.api_key_model_discovery=false',
    'web_search="disabled"', 'check_for_update_on_startup=false', `sqlite_home=${JSON.stringify(sqliteHome)}`,
    `sqlite_backfill_root=${JSON.stringify(backfillRoot)}`, 'features.memories=true', 'features.multi_agent=false',
    'features.multi_agent_v2=false', 'features.code_mode=false', 'features.hooks=false', 'features.apps=false',
    'features.plugins=false', 'features.shell_tool=false', 'features.background_paginated_rollout_migration=false',
    'features.local_thread_store_compression=false', `memories.root=${JSON.stringify(memoryBase)}`,
    `memories.version=${JSON.stringify(version)}`, 'memories.dual_write=false', 'memories.generate_memories=false',
    'memories.use_memories=true', 'memories.dedicated_tools=true',
    `model_providers.${providerName}={name="Owned loopback fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  ] : []
  if (!realAccount) { writeFileSync(configFile, config, { flag: 'wx', mode: 0o600 }); guards.set(configFile, sha(configFile)) }
  const env: Record<string, string> = { HOME: home, TMPDIR: privateDir, PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' }
  for (const key of ['USER', 'LOGNAME']) if (process.env[key]) env[key] = process.env[key]!
  if (!realAccount || accountMode === 'managed') env.CODEX_HOME = nativeCredentialHome
  attempt.writePrivate('binding-private.json', JSON.stringify({ env, cwd, memoryBase, sqliteHome, backfillRoot, directory, selected, note, negatives, noteFile,
    current, nativeCredentialHome, canonicalProfile, authBefore, identityPreflightFile, identityPreflightHash, originalTrees, cliOverrides,
    guardHashes: Object.fromEntries(guards), negativeTrees, candidateSourceCommit: pin.candidateSourceCommit, providerSha256: sha(cli), runId: randomUUID() }, null, 2))
  for (const next of ['write', 'read'] as const) {
    phase = next; requestCount = 0
    assert.equal(sha(cli), pin.providerExecutableSha256)
    for (const [file, hash] of guards) assert.equal(sha(file), hash)
    assert.equal(existsSync(join(credentialHome, 'auth.json')), false)
    assertAccount()
    for (const tree of negativeTrees) assert.deepEqual(snapshot(tree.root), tree.files)
    const child = spawn(cli, [...cliOverrides.flatMap((entry) => ['-c', entry]), 'app-server', '--strict-config'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let exited = false, finish!: () => void, reject!: (error: Error) => void
    const closed = new Promise<void>((resolve) => child.once('close', () => { exited = true; resolve() }))
    const completed = new Promise<void>((resolve, refuse) => { finish = resolve; reject = refuse })
    failPhase = reject
    child.once('error', () => reject(new Error('Owned candidate could not start')))
    child.stdin.on('error', () => reject(new Error('Native protocol input closed')))
    const capture = (channel: 'stdout' | 'stderr', chunk: Buffer): void => { try { output.append(channel, chunk) } catch { reject(new Error('Native output exceeded byte limit')); child.kill('SIGKILL') } }
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
    let threadId = '', turnId = '', completedTurn = '', initialized = false
    let pendingRead: 'account' | 'config' | undefined
    let protocolTimer = setTimeout(() => reject(new Error('Native initialize exceeded 15 seconds')), 15_000)
    const total = setTimeout(() => reject(new Error('Native launch exceeded 60 seconds')), 60_000)
    const maybeDone = (): void => { if (completedTurn && turnId) { assert.equal(completedTurn, turnId); assert.equal(requestCount, 2); finish() } }
    const startThread = (threadConfig?: Record<string, unknown>): void => {
      clearTimeout(protocolTimer); protocolTimer = setTimeout(() => reject(new Error('Native thread start exceeded 30 seconds')), 30_000)
      assertAccount()
      send({ id: 2, method: 'thread/start', params: { cwd, ephemeral: true, model: 'w13-fixture', modelProvider: providerName,
        approvalPolicy: 'never', sandbox: 'read-only', ...(threadConfig ? { config: threadConfig } : {}) } })
    }
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line)
        assert.ok(!message.error && !(message.method && message.id !== undefined), 'Unexpected native control/error request')
        if (message.id === 1) {
          assert.equal(initialized, false); initialized = true; clearTimeout(protocolTimer)
          if (realAccount) assert.equal(realpathSync(message.result.codexHome), canonicalProfile)
          send({ method: 'initialized' })
          if (realAccount) {
            pendingRead = 'account'; protocolTimer = setTimeout(() => reject(new Error('Native account/config readiness exceeded 30 seconds')), 30_000)
            send({ id: 4, method: 'account/read', params: { refreshToken: false } })
          } else startThread()
        } else if (message.id === 4) {
          assert.equal(pendingRead, 'account'); assert.equal(threadId, '')
          assert.equal(message.result?.account, null); assert.equal(message.result?.requiresOpenaiAuth, false)
          attempt!.writePrivate(`${phase}-account-private.json`, JSON.stringify({ response: message.result,
            observation: 'Anonymous owned model provider; native principal independently preflighted, no active model-account claim' }))
          pendingRead = 'config'; send({ id: 5, method: 'config/read', params: { cwd, includeLayers: true } })
        } else if (message.id === 5) {
          assert.equal(pendingRead, 'config'); assert.equal(threadId, '')
          const isolated = isolatedMemoryThreadConfig(message.result)
          const effective = message.result.config
          assert.equal(effective.memories?.root, memoryBase); assert.equal(effective.sqlite_home, sqliteHome)
          assert.equal(effective.sqlite_backfill_root, backfillRoot); assert.equal(effective.model_provider, providerName)
          assert.equal(effective.model_catalog_json, catalogFile)
          assert.equal(effective.memories.generate_memories, false); assert.equal(effective.memories.use_memories, true)
          assert.equal(effective.memories.version, version); assert.equal(effective.memories.dual_write, false)
          for (const key of ['hooks', 'apps', 'plugins', 'shell_tool', 'background_paginated_rollout_migration', 'local_thread_store_compression']) assert.equal(effective.features?.[key], false)
          for (const file of isolated.sourceFiles) {
            const state = sourceState(file)
            if (sourceGuards.has(file)) assert.deepEqual(state, sourceGuards.get(file)); else sourceGuards.set(file, state)
          }
          attempt!.writePrivate(`${phase}-resolved-config-private.json`, JSON.stringify({ response: message.result, threadConfig: isolated.config, sourceGuards: Object.fromEntries(sourceGuards) }))
          pendingRead = undefined; startThread(isolated.config)
        } else if (message.id === 2) {
          assert.equal(initialized, true); assert.equal(threadId, ''); clearTimeout(protocolTimer)
          threadId = message.result?.thread?.id; assert.ok(typeof threadId === 'string' && threadId.length > 0)
          attempt!.writePrivate(`${phase}-native-binding-private.json`, JSON.stringify({ threadId, lifecycleGeneration: next === 'write' ? 1 : 2 }))
          receipt.nativeInputs = Number(receipt.nativeInputs) + 1
          send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt }] } })
        } else if (message.id === 3) {
          turnId = message.result?.turn?.id; assert.ok(typeof turnId === 'string' && turnId.length > 0); maybeDone()
        } else if (message.method === 'turn/completed') {
          assert.equal(message.params?.threadId, threadId); assert.equal(message.params.turn.status, 'completed')
          completedTurn = message.params.turn.id; maybeDone()
        } else assert.equal(message.id, undefined)
      } catch (error) { reject(error instanceof Error ? error : new Error('Invalid native protocol')) }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-cockpit-w13-overlay-proof', version: '1' }, capabilities: { experimentalApi: true } } })
    try { await Promise.race([completed, closed.then(() => { throw new Error('Owned provider exited before proof completion') })]) }
    finally {
      clearTimeout(protocolTimer); clearTimeout(total)
      if (!exited) child.kill('SIGKILL')
      let retirement: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([closed, new Promise<never>((_resolve, refuse) => { retirement = setTimeout(() => { child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); refuse(new Error('Owned provider retirement uncertain')) }, 5_000) })]) }
      finally { clearTimeout(retirement) }
      if (exited) receipt.ownedProviderExits = Number(receipt.ownedProviderExits) + 1
      failPhase = undefined
    }
    assert.equal(readFileSync(noteFile, 'utf8'), note)
    for (const [file, hash] of guards) assert.equal(sha(file), hash)
    assert.equal(existsSync(join(credentialHome, 'auth.json')), false)
    assertAccount()
    for (const tree of negativeTrees) assert.deepEqual(snapshot(tree.root), tree.files)
    for (const base of [credentialHome, memoryBase, otherBase]) for (const name of ['memories', 'memories_v2']) {
      if (base !== memoryBase || name !== directory) assert.equal(existsSync(join(base, name, relativeNote)), false)
    }
  }
  const stateFile = (name: string): boolean => /^state(?:_\d+)?\.sqlite(?:-wal|-shm)?$/.test(name)
  assert.ok(readdirSync(sqliteHome).some(stateFile), 'Separate native SQLite state root was not observed')
  assert.ok(!readdirSync(credentialHome).some(stateFile), 'Native state reached the credential locator')
  receipt.observation = { selectedNativeContextOnBothLaunches: true, nativeNoteWritten: true, nativeReadAfterProviderRestart: true,
    fiveNegativeRootCanariesAbsent: true, fiveNegativeRootTreesUnchanged: true, ownedFictionalLocatorUnchanged: true,
    ownedFictionalAuthenticationFileAbsent: true, separateNativeSqliteStateObserved: true,
    ...(realAccount ? { nativePrincipalPreflightMatched: true, anonymousControlledModelExplicitlyObserved: true, originalCredentialLocatorRetained: true, authFileMetadataUnchanged: true,
      originalMemorySnapshotsUnchanged: true, configSourceHashesUnchanged: true, declaredMcpServersExplicitlyDisabledForThread: true } : {}) }
  receipt.verdict = 'PASS_NATIVE_CANDIDATE_OVERLAY_NOTE_WRITE_RESTART_READ'
} catch (error) {
  process.exitCode = 1; attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
} finally {
  if (server.listening) { server.closeAllConnections(); server.close() }
  try { verifyAccountEnd?.() } catch (error) {
    process.exitCode = 1; receipt.verdict = 'BLOCKED'
    attempt?.writePrivate('binding-guard-error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Binding guard failed')
  }
  attempt?.writePrivate('provider-stream-private.txt', output.snapshot())
  receipt.finishedAt = new Date().toISOString(); receipt.outputBytes = output.bytes; receipt.outputOverflow = output.overflow
  receipt.limitations = [realAccount ? 'Native provider principal independently preflighted; controlled model is anonymous, not a live-provider/account qualification' : 'Inert fictional credential locator; no real principal/account context qualification',
    'Original-memory snapshot records symlinks without traversing their targets',
    'Native ad-hoc note tool and subsequent native resource read; no automatic consolidation or promotion proof',
    'No worker/helper started; no concurrency, policy enforcement, cancellation, packaged, installed or full lifecycle acceptance',
    'Source candidate only; no runtime adoption or CLI replacement']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, nativeInputs: receipt.nativeInputs, ownedProviderExits: receipt.ownedProviderExits }))
}
