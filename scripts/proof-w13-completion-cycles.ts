// One planned native feasibility attempt. This is not production enforcement or cancellation.
// Two host callbacks must share a provider cycle ID. Raw output and errors stay private.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { claudeIdentityFrom } from '../server/agents/accounts/identity.ts'
import { ParentCompletionOracle, ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const cli = process.env.COCKPIT_W13_CLAUDE ?? ''
const evidence = process.env.COCKPIT_PROOF_DIR ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const descriptor = process.env.COCKPIT_PROOF_CONTEXT ?? ''
const workspaceKind = process.env.COCKPIT_W13_FIXTURE_WORKSPACE ?? 'synthetic'
const receipt: Record<string, unknown> = { scenario: 'native-claude-completion-cycle-callbacks',
  startedAt: new Date().toISOString(), verdict: 'BLOCKED', modelInputs: 0, identityQueries: 0,
  layer: 'direct-cli', accountAlias: 'authorized-managed', protocolBudgetMs: 15_000, launchBudgetMs: 60_000 }
const output = new ProbeOutput()
let attempt: ProbeAttempt | undefined, oracle: ParentCompletionOracle | undefined, ownedExited = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(['synthetic', 'primary', 'worktree'].includes(workspaceKind))
  const notBefore = Number(process.env.COCKPIT_W13_NOT_BEFORE_MS ?? '0')
  assert.ok(Number.isSafeInteger(notBefore) && notBefore >= 0 && Date.now() >= notBefore, 'Recorded provider reset has not arrived')
  assert.ok([cli, evidence, privateDir, descriptor].every(isAbsolute))
  const privateRoot = realpathSync(join(process.env.HOME ?? '', 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot), 'Diagnostics must remain in the private vault')
  assert.ok(realpathSync(descriptor).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir)
  attempt.create()
  assert.equal(sha(cli), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const script = fileURLToPath(import.meta.url)
  const root = dirname(dirname(script))
  receipt.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.workspaceScope = workspaceKind
  receipt.harnessSha256 = sha(script)
  receipt.oracleSha256 = sha(join(dirname(script), 'lib', 'w13-completion-probe.ts'))
  receipt.dependencyLockSha256 = sha(join(root, 'package-lock.json'))
  const context = JSON.parse(readFileSync(descriptor, 'utf8')) as { accountId: string; literalProfileDir: string; canonicalProfileDir: string;
    accountMode?: 'default' | 'managed'; home?: string }
  assert.ok(context.accountMode === undefined || ['default', 'managed'].includes(context.accountMode))
  const accountMode = context.accountMode ?? 'managed'
  receipt.accountAlias = accountMode === 'managed' ? 'authorized-managed' : 'native-default'
  assert.ok(typeof context.accountId === 'string' && context.accountId.length > 0)
  assert.ok(isAbsolute(context.literalProfileDir) && isAbsolute(context.canonicalProfileDir))
  const state = join(process.env.HOME ?? '', '.agent-cockpit')
  type Account = { id: string; agent: string; mode: string; isolation: string; generation: number; identity?: { state: string; key?: string } }
  const selectedAccount = (): Account => {
    const registry = JSON.parse(readFileSync(join(state, 'accounts.json'), 'utf8')) as { accounts: Account[] }
    const rows = registry.accounts.filter((row) => row.id === context.accountId)
    assert.equal(rows.length, 1)
    const account = rows[0]!
    assert.ok(account.agent === 'claude' && account.mode === accountMode && account.identity?.state === 'known')
    assert.equal(account.isolation, accountMode === 'managed' ? 'CLAUDE_CONFIG_DIR' : 'none')
    assert.ok(Number.isSafeInteger(account.generation) && account.generation >= 1)
    return account
  }
  const account = selectedAccount()
  // Use the literal established credential locator; never derive a substitute from realpath.
  if (accountMode === 'managed') assert.equal(context.literalProfileDir, join(state, 'account-profiles', context.accountId))
  else {
    assert.equal(context.accountId, 'default-claude')
    assert.equal(context.home, process.env.HOME)
    assert.equal(context.literalProfileDir, join(context.home!, '.claude'))
  }
  assert.equal(realpathSync(context.literalProfileDir), context.canonicalProfileDir)
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  if (accountMode === 'managed') env.CLAUDE_CONFIG_DIR = context.literalProfileDir
  const deadline = Date.now() + 60_000
  receipt.identityQueries = 1
  const identity = claudeIdentityFrom(execFileSync(cli, ['auth', 'status', '--json'],
    { env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }))
  assert.ok(identity.state === 'known' && identity.key === account.identity?.key, 'Selected account identity did not match')
  receipt.identityMatched = true
  receipt.accountGeneration = account.generation
  receipt.provider = { name: 'claude', version: '2.1.220', executableSha256: sha(cli), runtimeSha256: sha(process.execPath) }
  const project = workspaceKind === 'primary' ? join(dirname(dirname(root)), 'agent-cockpit')
    : workspaceKind === 'worktree' ? root : join(privateDir, 'project')
  if (workspaceKind === 'synthetic') mkdirSync(project, { mode: 0o700 })
  else assert.equal(realpathSync(project), project)
  const settings = join(privateDir, 'settings.json'), mcp = join(privateDir, 'mcp.json')
  writeFileSync(settings, '{"hooks":{},"enabledPlugins":{},"autoMemoryEnabled":false}', { flag: 'wx', mode: 0o600 })
  writeFileSync(mcp, '{"mcpServers":{}}', { flag: 'wx', mode: 0o600 })
  const sessionId = randomUUID(), initId = randomUUID(), runId = randomUUID()
  const cycleOracle = new ParentCompletionOracle(sessionId)
  oracle = cycleOracle
  attempt.writePrivate('binding-private.json', JSON.stringify({ ...context, accountGeneration: account.generation,
    identityKey: identity.key, sessionId, runId, project, lifecycleGeneration: 1 }, null, 2) + '\n')
  receipt.bindingRecordedPrivately = true
  await new Promise<void>((resolve, reject) => {
    let finished = false, initialized = false, failure: Error | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(cli, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--session-id', sessionId, '--no-session-persistence',
      '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--mcp-config', mcp,
      '--setting-sources', '', '--settings', settings], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
    const stop = (error?: Error): void => {
      if (error) failure ??= error
      if (finished) return
      finished = true
      clearTimeout(timer); clearTimeout(initTimer)
      // Only this invocation's no-tools child. This is probe retirement, not a cancellation proof.
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      closeTimer = setTimeout(() => {
        child.unref()
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
        reject(new Error('Owned provider termination is uncertain'))
      }, 5_000)
    }
    const remaining = deadline - Date.now()
    const timer = setTimeout(() => stop(new Error('Single launch attempt exceeded 60 seconds')), Math.max(0, remaining))
    const initTimer = setTimeout(() => stop(new Error('Protocol initialize exceeded 15 seconds')), Math.max(0, Math.min(15_000, remaining)))
    child.stdin.on('error', () => stop(new Error('Provider stopped accepting protocol input')))
    const capture = (channel: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (output.overflow) return
      try { output.append(channel, chunk) } catch (error) {
        stop(error instanceof Error ? error : new Error('Output capture failed'))
        child.stdout.destroy(); child.stderr.destroy()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
    child.on('error', () => stop(new Error('Owned provider could not start')))
    child.on('close', () => {
      ownedExited = true
      if (!finished) stop(new Error('Provider exited before the two-cycle oracle'))
      clearTimeout(closeTimer)
      if (failure) reject(failure); else resolve()
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (finished) return
      try {
        const message = JSON.parse(line)
        if (message.type === 'control_response') {
          assert.equal(message.response?.request_id, initId)
          assert.equal(message.response.subtype, 'success')
          assert.equal(initialized, false)
          const current = selectedAccount()
          assert.equal(current.generation, account.generation)
          assert.equal(current.identity?.key, account.identity?.key)
          initialized = true
          clearTimeout(initTimer)
          receipt.modelInputs = 1
          send({ type: 'user', session_id: sessionId, message: { role: 'user', content: 'Reply with READY. Do not use tools or start helpers.' } })
        } else if (message.type === 'control_request') {
          assert.equal(initialized, true)
          const response = cycleOracle.callback(message)
          send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
        } else if (message.type === 'result') {
          cycleOracle.complete(message)
          stop()
        }
      } catch (error) { stop(error instanceof Error ? error : new Error('Unexpected probe failure')) }
    })
    // The pinned initialize schema makes matcher optional. Runtime proof is this attempt only.
    send({ type: 'control_request', request_id: initId,
      request: { subtype: 'initialize', hooks: { Stop: [{ hookCallbackIds: cycleOracle.callbacks, timeout: 5 }] } } })
  })
  receipt.trustedCycleIdSharedAcrossHooks = true
  receipt.modelTextUsedForCycleIdentity = false
  receipt.verdict = 'PASS_NATIVE_PARENT_CYCLE_MECHANISM'
} catch (error) {
  receipt.error = 'Probe stopped; inspect private diagnostics before any retry'
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  receipt.cycles = oracle?.summary() ?? []
  attempt?.writePrivate('provider-stream-private.txt', output.snapshot())
  receipt.outputBytes = output.bytes
  receipt.outputOverflow = output.overflow
  receipt.ownedProviderExited = ownedExited
  receipt.finishedAt = new Date().toISOString()
  receipt.limitations = ['Parent Stop only; no subagent was started', 'Mechanism feasibility, not production hook enforcement or cancellation',
    'Default/managed and primary/worktree matrix remains to qualify', 'Callback failure semantics are not claimed fail-closed',
    'No-session-persistence requested; provider-side retention is not controlled by this probe']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, modelInputs: receipt.modelInputs, ownedProviderExited: ownedExited }))
}
