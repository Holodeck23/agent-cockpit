// One planned native feasibility attempt. This is not production enforcement or cancellation.
// Observe bound completion cycles, controlled memory, or a selected synthetic skill/resource.
// Raw output and errors stay private; each mode retains its own frozen input identity.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { claudeIdentityFrom } from '../server/agents/accounts/identity.ts'
import { ParentCompletionOracle, ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { assessClaudeMemoryRecall } from './lib/w13-claude-memory-oracle.ts'
import { ClaudeSkillResourceOracle, requireNativeSkillCommand } from './lib/w13-claude-skill-oracle.ts'

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const cli = process.env.COCKPIT_W13_CLAUDE ?? ''
const evidence = process.env.COCKPIT_PROOF_DIR ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const descriptor = process.env.COCKPIT_PROOF_CONTEXT ?? ''
const workspaceKind = process.env.COCKPIT_W13_FIXTURE_WORKSPACE ?? 'synthetic'
const probeKind = process.env.COCKPIT_W13_PROBE_KIND ?? 'completion-cycles'
const skillInvocation = process.env.COCKPIT_W13_SKILL_INVOCATION ?? 'namespaced'
const fixtureCheckout = process.env.COCKPIT_W13_SYNTHETIC_CHECKOUT ?? 'primary'
const skillCollision = process.env.COCKPIT_W13_SKILL_COLLISION === '1'
const completionProbe = probeKind.startsWith('completion-')
const memoryProbe = probeKind.startsWith('memory-')
const receipt: Record<string, unknown> = { scenario: 'native-claude-completion-cycle-callbacks',
  startedAt: new Date().toISOString(), verdict: 'BLOCKED', modelInputs: 0, identityQueries: 0,
  layer: 'direct-cli', accountAlias: 'authorized-managed', protocolBudgetMs: 15_000, launchBudgetMs: 60_000 }
const output = new ProbeOutput()
let attempt: ProbeAttempt | undefined, oracle: ParentCompletionOracle | undefined, ownedExited = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(['synthetic', 'primary', 'worktree'].includes(workspaceKind))
  assert.ok(['completion-cycles', 'completion-second-rejection', 'memory-on', 'memory-off', 'skill-resource'].includes(probeKind))
  assert.ok(['namespaced', 'bare'].includes(skillInvocation))
  assert.ok(['primary', 'worktree'].includes(fixtureCheckout))
  if (skillInvocation === 'bare' || skillCollision) {
    assert.equal(probeKind, 'skill-resource')
    assert.equal(workspaceKind, 'synthetic', 'Bare discovery must not write into the actual checkout')
  }
  receipt.scenario = completionProbe ? receipt.scenario : memoryProbe
    ? 'native-claude-controlled-memory-recall' : 'native-claude-selected-skill-resource'
  receipt.probeKind = probeKind
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
  if (memoryProbe) receipt.memoryOracleSha256 = sha(join(dirname(script), 'lib', 'w13-claude-memory-oracle.ts'))
  if (probeKind === 'skill-resource') receipt.skillOracleSha256 = sha(join(dirname(script), 'lib', 'w13-claude-skill-oracle.ts'))
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
  let project = workspaceKind === 'primary' ? join(dirname(dirname(root)), 'agent-cockpit')
    : workspaceKind === 'worktree' ? root : join(privateDir, 'project')
  if (workspaceKind === 'synthetic') mkdirSync(project, { mode: 0o700 })
  else assert.equal(realpathSync(project), project)
  if (skillInvocation === 'bare' || skillCollision) {
    const gitHome = join(privateDir, 'git-home')
    mkdirSync(gitHome, { mode: 0o700 })
    const gitEnv = { HOME: gitHome, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    execFileSync('/usr/bin/git', ['init', '-q', project], { env: gitEnv, timeout: 10_000 })
    if (fixtureCheckout === 'worktree') {
      execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=W13 fixture', '-c', 'user.email=w13@example.invalid',
        'commit', '--allow-empty', '-qm', 'Synthetic worktree baseline'], { env: gitEnv, timeout: 10_000 })
      const worktree = join(privateDir, 'worktree')
      execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'w13-fixture', worktree], { env: gitEnv, timeout: 10_000 })
      project = worktree
    }
    project = realpathSync(project)
    receipt.fixtureWorkspaceScope = fixtureCheckout
  }
  const settingSources = skillInvocation === 'bare' || skillCollision ? 'project' : ''
  if (settingSources) receipt.nativeSettingSources = ['owned-fixture-project']
  const settings = join(privateDir, 'settings.json'), mcp = join(privateDir, 'mcp.json')
  const memoryEnabled = probeKind === 'memory-on'
  const selected = `W13MEM_SELECTED_${randomUUID()}`, excluded = `W13MEM_EXCLUDED_${randomUUID()}`
  let prompt = 'Reply with READY. Do not use tools or start helpers.'
  if (memoryProbe) {
    for (const name of ['selected-memory', 'unselected-memory']) mkdirSync(join(privateDir, name), { mode: 0o700 })
    writeFileSync(join(privateDir, 'selected-memory/MEMORY.md'), `# Synthetic memory\nThe synthetic W13 selection word is ${selected}.\n`, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(privateDir, 'unselected-memory/MEMORY.md'), `# Unselected memory\nThe other W13 selection word is ${excluded}.\n`, { flag: 'wx', mode: 0o600 })
    prompt = 'What is the synthetic W13 selection word from auto memory? Reply with only that word, or UNKNOWN if absent. Do not use tools.'
    receipt.nativeMemorySelection = memoryEnabled ? 'on' : 'off'
  }
  const skillMarker = `W13_SKILL_SELECTED_${randomUUID()}`, resourceMarker = `W13_RESOURCE_${randomUUID()}`
  const otherSkillMarker = `W13_SKILL_UNSELECTED_${randomUUID()}`, skillArgs = `--label "two words"  --target ${randomUUID()}`
  let plugin = '', skillSource = '', resourceFile = '', skillSourceHash = '', resourceHash = ''
  if (probeKind === 'skill-resource') {
    const skillDocument = (marker: string): string => `---\nname: w13-proof-skill\ndescription: Synthetic W13 native argument and resource proof.\n---\n\nUse Read exactly once to read reference.txt in this skill's base directory. Do not read any other file or use another tool.\nReply without code fences, exactly: ${marker}, then a newline, then the word from reference.txt, then a newline, then the exact invocation arguments below, preserving quotes and double spaces.\nInvocation arguments:\n<arguments>\n$ARGUMENTS\n</arguments>\n`
    for (const name of ['selected-plugin', 'unselected-plugin']) {
      const base = join(privateDir, name), skill = join(base, 'skills/w13-proof-skill')
      mkdirSync(join(base, '.claude-plugin'), { recursive: true, mode: 0o700 })
      mkdirSync(skill, { recursive: true, mode: 0o700 })
      writeFileSync(join(base, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'w13-proof-plugin', version: '1.0.0' }), { flag: 'wx', mode: 0o600 })
      const marker = name === 'selected-plugin' && !(skillCollision && skillInvocation === 'bare') ? skillMarker : otherSkillMarker
      writeFileSync(join(skill, 'SKILL.md'), skillDocument(marker), { flag: 'wx', mode: 0o600 })
      writeFileSync(join(skill, 'reference.txt'), (marker === skillMarker ? resourceMarker : otherSkillMarker) + '\n', { flag: 'wx', mode: 0o600 })
    }
    plugin = realpathSync(join(privateDir, 'selected-plugin'))
    skillSource = join(plugin, 'skills/w13-proof-skill/SKILL.md')
    resourceFile = join(plugin, 'skills/w13-proof-skill/reference.txt')
    if (skillInvocation === 'bare' || skillCollision) {
      const bareSource = join(project, '.claude/skills/w13-proof-skill')
      mkdirSync(bareSource, { recursive: true, mode: 0o700 })
      writeFileSync(join(bareSource, 'SKILL.md'), skillDocument(skillInvocation === 'bare' ? skillMarker : otherSkillMarker), { flag: 'wx', mode: 0o600 })
      writeFileSync(join(bareSource, 'reference.txt'), (skillInvocation === 'bare' ? resourceMarker : otherSkillMarker) + '\n', { flag: 'wx', mode: 0o600 })
      if (skillCollision) {
        attempt.writePrivate('collision-source-manifest-private.json', JSON.stringify([
          { kind: 'plugin', file: skillSource, sha256: sha(skillSource), resource: resourceFile, resourceSha256: sha(resourceFile) },
          { kind: 'bare', file: join(bareSource, 'SKILL.md'), sha256: sha(join(bareSource, 'SKILL.md')),
            resource: join(bareSource, 'reference.txt'), resourceSha256: sha(join(bareSource, 'reference.txt')) },
        ], null, 2))
        receipt.collisionSourcesBoundPrivately = true
      }
      if (skillInvocation === 'bare') {
        skillSource = join(bareSource, 'SKILL.md'); resourceFile = join(bareSource, 'reference.txt')
        if (!skillCollision) plugin = ''
      }
    }
    skillSourceHash = sha(skillSource); resourceHash = sha(resourceFile)
    prompt = `${skillInvocation === 'bare' ? '/w13-proof-skill' : '/w13-proof-plugin:w13-proof-skill'} ${skillArgs}`
    receipt.skillInvocation = skillInvocation
    receipt.sameNameSkillCollision = skillCollision
  }
  writeFileSync(settings, JSON.stringify({ hooks: {}, enabledPlugins: {}, autoMemoryEnabled: memoryEnabled,
    ...(memoryProbe ? { autoMemoryDirectory: join(privateDir, 'selected-memory') } : {}) }), { flag: 'wx', mode: 0o600 })
  writeFileSync(mcp, '{"mcpServers":{}}', { flag: 'wx', mode: 0o600 })
  const sessionId = randomUUID(), initId = randomUUID(), runId = randomUUID()
  const cycleOracle = new ParentCompletionOracle(sessionId, probeKind === 'completion-second-rejection')
  const skillOracle = probeKind === 'skill-resource' ? new ClaudeSkillResourceOracle(sessionId, resourceFile,
    skillMarker, resourceMarker, otherSkillMarker, skillArgs) : undefined
  if (completionProbe) oracle = cycleOracle
  attempt.writePrivate('binding-private.json', JSON.stringify({ ...context, accountGeneration: account.generation,
    identityKey: identity.key, sessionId, runId, project, lifecycleGeneration: 1, settingsSha256: sha(settings),
    ...(memoryProbe ? { memorySelection: memoryEnabled, selectedMarker: selected, excludedMarker: excluded,
      selectedMemorySha256: sha(join(privateDir, 'selected-memory/MEMORY.md')), excludedMemorySha256: sha(join(privateDir, 'unselected-memory/MEMORY.md')) } : {}),
    ...(skillOracle ? { plugin, skillInvocation, skillSource, resourceFile, skillSourceHash, resourceHash, skillMarker, resourceMarker, otherSkillMarker, arguments: skillArgs } : {}) }, null, 2) + '\n')
  receipt.bindingRecordedPrivately = true
  await new Promise<void>((resolve, reject) => {
    let finished = false, initialized = false, failure: Error | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(cli, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--session-id', sessionId, '--no-session-persistence',
      '--model', 'haiku', '--tools', skillOracle ? 'Read' : '', '--strict-mcp-config', '--mcp-config', mcp,
      '--setting-sources', settingSources, '--settings', settings, ...(skillOracle && plugin ? ['--plugin-dir', plugin] : [])], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
    const stop = (error?: Error): void => {
      if (error) failure ??= error
      if (finished) return
      finished = true
      clearTimeout(timer); clearTimeout(initTimer)
      // Only this invocation's owned child. This is probe retirement, not a cancellation proof.
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
      if (!finished) stop(new Error('Provider exited before the selected probe oracle'))
      clearTimeout(closeTimer)
      if (failure) reject(failure); else resolve()
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (finished) return
      try {
        const message = JSON.parse(line)
        skillOracle?.record(message)
        if (completionProbe) cycleOracle.observe(message)
        if (message.type === 'control_response') {
          assert.equal(message.response?.request_id, initId)
          assert.equal(message.response.subtype, 'success')
          assert.equal(initialized, false)
          const current = selectedAccount()
          assert.equal(current.generation, account.generation)
          assert.equal(current.identity?.key, account.identity?.key)
          if (skillOracle) {
            assert.equal(sha(skillSource), skillSourceHash); assert.equal(sha(resourceFile), resourceHash)
            requireNativeSkillCommand(message.response.response?.commands,
              skillInvocation === 'bare' ? 'w13-proof-skill' : 'w13-proof-plugin:w13-proof-skill')
            if (skillCollision) {
              requireNativeSkillCommand(message.response.response?.commands, 'w13-proof-skill')
              requireNativeSkillCommand(message.response.response?.commands, 'w13-proof-plugin:w13-proof-skill')
              receipt.bothCollisionCommandsDiscoveredBeforeInput = true
            }
            receipt.skillDiscoveredBeforeInput = true
          }
          initialized = true
          clearTimeout(initTimer)
          receipt.modelInputs = 1
          send({ type: 'user', session_id: sessionId, message: { role: 'user', content: prompt } })
        } else if (message.type === 'control_request') {
          assert.equal(initialized, true)
          if (skillOracle) {
            const request = message.request
            let allowed = false
            try {
              const current = selectedAccount()
              assert.equal(current.generation, account.generation); assert.equal(current.identity?.key, account.identity?.key)
              if (request?.subtype === 'hook_callback') {
                assert.equal(request.callback_id, 'skill-resource-path-policy')
                assert.equal(request.input?.hook_event_name, 'PreToolUse'); assert.equal(request.input.session_id, sessionId)
                allowed = skillOracle.permits(request.input.tool_name, request.input.tool_input)
              } else if (request?.subtype === 'can_use_tool') allowed = skillOracle.permits(request.tool_name, request.input)
              assert.equal(sha(skillSource), skillSourceHash); assert.equal(sha(resourceFile), resourceHash)
            } catch { allowed = false }
            const response = request?.subtype === 'hook_callback'
              ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny',
                permissionDecisionReason: 'Reviewed synthetic selected-resource path only' } }
              : allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Unreviewed synthetic resource access' }
            send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
            if (!allowed) stop(new Error('Native skill attempted an unreviewed resource or control request'))
            else if (request.subtype === 'hook_callback') skillOracle.policyAdmissions++
            return
          }
          assert.ok(completionProbe, 'Unexpected native control request in no-tools memory probe')
          const response = cycleOracle.callback(message)
          send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
        } else if (message.type === 'result') {
          if (completionProbe) cycleOracle.complete(message)
          else if (skillOracle) receipt.skillObservation = skillOracle.complete(message, output.snapshot().toString('utf8'))
          else receipt.memoryObservation = assessClaudeMemoryRecall(message, sessionId, selected, excluded, prompt,
            memoryEnabled, output.snapshot().toString('utf8'))
          stop()
        }
      } catch (error) { stop(error instanceof Error ? error : new Error('Unexpected probe failure')) }
    })
    // The pinned initialize schema makes matcher optional. Runtime proof is this attempt only.
    send({ type: 'control_request', request_id: initId,
      request: { subtype: 'initialize', hooks: completionProbe
        ? { Stop: [{ hookCallbackIds: cycleOracle.callbacks, timeout: 5 }] }
        : skillOracle ? { PreToolUse: [{ matcher: 'Read', hookCallbackIds: ['skill-resource-path-policy'], timeout: 5 }] } : null } })
  })
  if (completionProbe) {
    receipt.trustedCycleIdSharedAcrossHooks = true
    receipt.modelTextUsedForCycleIdentity = false
    if (probeKind === 'completion-second-rejection') receipt.terminalObservation = cycleOracle.terminalObservation()
  }
  receipt.verdict = probeKind === 'completion-second-rejection' ? 'PASS_NATIVE_SECOND_REJECTION_STOP'
    : completionProbe ? 'PASS_NATIVE_PARENT_CYCLE_MECHANISM'
    : memoryProbe ? 'PASS_NATIVE_CONTROLLED_MEMORY_RECALL' : 'PASS_NATIVE_SELECTED_SKILL_AND_RESOURCE'
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
  receipt.limitations = [completionProbe ? 'Parent Stop only; no subagent was started'
    : memoryProbe ? 'Synthetic selected auto-memory overlay only; no real memory copied or native writeback/lifecycle proof'
      : `Synthetic selected ${skillInvocation} skill and one read-only resource; no real user skill or executable dependency`, 'Mechanism feasibility, not production hook enforcement or cancellation',
    'Default/managed and primary/worktree matrix remains to qualify', 'Callback failure semantics are not claimed fail-closed',
    'No-session-persistence requested; provider-side retention is not controlled by this probe']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, modelInputs: receipt.modelInputs, ownedProviderExited: ownedExited }))
}
