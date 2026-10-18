// Candidate credential-locator/principal check only. No thread, model, login, refresh or credential copy.
import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'

process.umask(0o077)
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const contextDir = process.env.COCKPIT_PROOF_CONTEXT ?? '', home = process.env.HOME ?? ''
const diagnostic = process.env.COCKPIT_PROOF_DIAGNOSTIC === '1'
// Identity-only launches may retain native SQLite. This never qualifies isolated memory effects.
const nativeStateIdentityOnly = process.env.COCKPIT_PROOF_NATIVE_STATE_IDENTITY_ONLY === '1'
const receipt: Record<string, unknown> = { scenario: 'native-candidate-real-principal-at-fixed-credential-locator', verdict: 'BLOCKED',
  diagnosticOnly: diagnostic, nativeStateIdentityOnly, modelInputs: 0, hostCredentialPayloadReads: 0, registryWrites: 0, rows: [], ownedProviderExits: 0 }
let attempt: ProbeAttempt | undefined
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(!(diagnostic && nativeStateIdentityOnly), 'Diagnostic retains its isolated-state startup scope')
  assert.ok([cli, evidence, privateDir, contextDir].every(isAbsolute))
  const privateRoot = realpathSync(join(home, 'vault/clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot) && realpathSync(contextDir).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  const script = fileURLToPath(import.meta.url), worktree = dirname(dirname(script)), primary = join(dirname(dirname(worktree)), 'agent-cockpit')
  const manifest = join(worktree, 'vendor/codex-memory-root/upstream.json'), pin = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(pin.candidateBuilt, true); assert.equal(pin.candidateSourceCommit, 'eeb03f10101987bf8140701f9ad30276e6427e9b')
  assert.equal(sha(cli), pin.providerExecutableSha256)
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: worktree, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(script)
  receipt.provider = { executableSha256: sha(cli), sourceCommit: pin.candidateSourceCommit, version: pin.providerVersionObserved, manifestSha256: sha(manifest) }
  const registry = join(home, '.agent-cockpit/accounts.json'), registryHash = sha(registry)
  const authMetadata = (profile: string): unknown => {
    try { const stat = lstatSync(join(profile, 'auth.json')); return { device: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  contexts: for (const mode of ['default', 'managed']) for (const scope of ['primary', 'worktree']) {
    const label = `${mode}-${scope}`, saved = JSON.parse(readFileSync(join(contextDir, `codex-${label}-private.json`), 'utf8'))
    const current = JSON.parse(readFileSync(registry, 'utf8')).accounts.find((row: any) => row.id === saved.account.id)
    assert.deepEqual(current, saved.account); assert.equal(current.agent, 'codex'); assert.equal(current.mode, mode)
    assert.ok(current.identity?.state === 'known' && saved.identity.key === current.identity.key)
    const literalProfile = mode === 'default' ? join(home, '.codex') : join(home, '.agent-cockpit/account-profiles', current.id)
    const canonicalProfile = realpathSync(literalProfile), before = authMetadata(literalProfile)
    const cwd = scope === 'primary' ? primary : worktree; assert.equal(saved.cwd, cwd)
    const env: Record<string, string> = { HOME: home }
    for (const name of ['USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL']) if (process.env[name]) env[name] = process.env[name]!
    if (mode === 'managed') {
      assert.equal(current.isolation, 'CODEX_HOME'); assert.equal(saved.env.CODEX_HOME, literalProfile)
      assert.equal(saved.canonicalProfile, canonicalProfile); env.CODEX_HOME = literalProfile
    } else { assert.equal(current.isolation, 'none'); assert.equal(saved.env.CODEX_HOME, undefined) }
    const memoryBase = join(privateDir, `${label}-memory`), sqliteHome = nativeStateIdentityOnly ? undefined : join(privateDir, `${label}-state`)
    mkdirSync(memoryBase, { mode: 0o700 }); if (sqliteHome) mkdirSync(sqliteHome, { mode: 0o700 })
    const config = [`memories.root=${JSON.stringify(memoryBase)}`, ...(sqliteHome ? [`sqlite_home=${JSON.stringify(sqliteHome)}`] : []),
      'memories.generate_memories=false', 'memories.use_memories=false', 'features.memories=false', 'features.multi_agent=false',
      'features.hooks=false', 'features.apps=false', 'features.plugins=false', 'features.shell_tool=false',
      'web_search="disabled"', 'check_for_update_on_startup=false']
    assert.equal(sha(registry), registryHash); assert.equal(sha(cli), pin.providerExecutableSha256)
    attempt.writePrivate(`${label}-prelaunch-private.json`, JSON.stringify({ current, env, literalProfile, canonicalProfile,
      cwd, memoryBase, sqliteHome, config, authMetadataBefore: before }, null, 2))
    const output = new ProbeOutput()
    let value: unknown
    try {
      value = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(cli, [...config.flatMap((entry) => ['-c', entry]), 'app-server', '--strict-config'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
        let settled = false, initialized = false, failure: Error | undefined, answer: unknown
        let retirement: ReturnType<typeof setTimeout> | undefined
        let sampling: ReturnType<typeof setTimeout> | undefined
        const stop = (error?: Error): void => {
          if (settled) return
          settled = true; failure = error; clearTimeout(total); clearTimeout(protocol); clearTimeout(sampling)
          if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          retirement = setTimeout(() => { child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); reject(new Error('Owned candidate retirement uncertain')) }, 5_000)
        }
        const total = setTimeout(() => stop(new Error('Candidate identity launch exceeded 60 seconds')), 60_000)
        let protocol = setTimeout(() => stop(new Error('Candidate initialize exceeded 15 seconds')), 15_000)
        if (diagnostic) sampling = setTimeout(() => {
          if (!child.pid || settled) return
          execFile('/usr/bin/sample', [String(child.pid), '1', '1', '-file', join(privateDir, `${label}-startup-sample-private.txt`)],
            { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
              attempt!.writePrivate(`${label}-sampler-private.txt`, `${stdout}\n${stderr}`)
              receipt.startupSampleCaptured = !error
              if (error) stop(new Error('Owned startup sampling failed; stop without bypass'))
            })
        }, 4_000)
        child.once('error', () => stop(new Error('Candidate could not start')))
        child.stdin.on('error', () => stop(new Error('Candidate protocol input closed')))
        const capture = (channel: 'stdout' | 'stderr', chunk: Buffer): void => { try { output.append(channel, chunk) } catch { stop(new Error('Candidate output exceeded byte bound')) } }
        child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
        child.once('close', () => {
          if (!settled) stop(new Error('Candidate exited before account response'))
          clearTimeout(retirement); if (child.pid) receipt.ownedProviderExits = Number(receipt.ownedProviderExits) + 1
          if (failure) reject(failure); else resolve(answer)
        })
        const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (settled) return
          try {
            const message = JSON.parse(line)
            assert.ok(!message.error && !(message.method && message.id !== undefined), 'Candidate refused or requested an unexpected action')
            if (message.id === 1) {
              assert.equal(initialized, false); initialized = true; clearTimeout(protocol)
              if (diagnostic) { answer = message.result; stop(); return }
              protocol = setTimeout(() => stop(new Error('Candidate account response exceeded 30 seconds')), 30_000)
              send({ method: 'initialized' }); send({ id: 2, method: 'account/read', params: { refreshToken: false } })
            } else if (message.id === 2) { assert.equal(initialized, true); answer = message.result; stop() }
            else assert.equal(message.id, undefined)
          } catch (error) { stop(error instanceof Error ? error : new Error('Invalid candidate protocol')) }
        })
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-cockpit-w13-candidate-identity', version: '1' }, capabilities: { experimentalApi: true } } })
      })
    } finally { attempt.writePrivate(`${label}-provider-stream-private.txt`, output.snapshot()) }
    if (diagnostic) {
      assert.equal(sha(registry), registryHash); assert.deepEqual(authMetadata(literalProfile), before)
      receipt.verdict = 'DIAGNOSTIC_INITIALIZE_COMPLETED_NO_ACCOUNT_QUERY'
      break contexts
    }
    const identity = codexIdentityFrom(value)
    attempt.writePrivate(`${label}-binding-private.json`, JSON.stringify({ current, env, literalProfile, canonicalProfile, cwd,
      memoryBase, sqliteHome, config, accountResponse: value, identity, authMetadataBefore: before, authMetadataAfter: authMetadata(literalProfile) }, null, 2))
    assert.ok(identity.state === 'known' && identity.key === current.identity.key, 'Candidate principal mismatch/unknown; stop without refresh or fallback')
    assert.equal(realpathSync(literalProfile), canonicalProfile); assert.deepEqual(authMetadata(literalProfile), before)
    assert.equal(sha(registry), registryHash)
    ;(receipt.rows as unknown[]).push({ accountMode: mode, workspaceScope: scope, accountGeneration: current.generation,
      identityMatched: true, credentialLocatorRetained: true, authFileMetadataUnchanged: true, nativeStateIdentityOnly,
      modelInputs: 0, memoryEffectQualification: false })
  }
  if (!diagnostic) receipt.verdict = 'PASS_CANDIDATE_FOUR_CONTEXT_IDENTITY_WITH_MEMORY_ROOT_OVERRIDE'
} catch (error) {
  process.exitCode = 1; attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
} finally {
  receipt.limitations = ['Native cached identity only, not remote authentication/token-validity proof',
    'Native-state identity-only mode retains existing state and permits native startup maintenance; it does not qualify isolated SQLite startup',
    'No real-account native memory loading, skill/policy effects, worker, lifecycle, package or installed acceptance',
    'No credential payload read by host, login, forced refresh, registry update, adoption or CLI replacement']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, contexts: (receipt.rows as unknown[]).length, ownedProviderExits: receipt.ownedProviderExits, modelInputs: 0 }))
}
