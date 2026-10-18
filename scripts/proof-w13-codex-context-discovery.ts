// Read-only native metadata at exact already-matched Codex account/workspace contexts.
// No thread/model/tool, connector-status call, login, forced refresh or host-side profile config write.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { ProbeAttempt } from './lib/w13-completion-probe.ts'

process.umask(0o077)
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
let attempt: ProbeAttempt | undefined
const receipt: Record<string, unknown> = { scenario: 'native-codex-real-context-discovery', verdict: 'BLOCKED',
  modelInputs: 0, credentialPayloadReads: 0, connectorStatusCalls: 0, metadataQueries: 0, rows: [] }
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  const home = process.env.HOME ?? '', contextDir = process.env.COCKPIT_PROOF_CONTEXT ?? '', cli = process.env.COCKPIT_W13_CODEX ?? ''
  assert.ok([evidence, privateDir, contextDir, cli].every(isAbsolute))
  const privateRoot = realpathSync(join(home, 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot) && realpathSync(contextDir).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  assert.equal(sha(cli), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const registry = join(home, '.agent-cockpit/accounts.json'), registryHash = sha(registry)
  const script = fileURLToPath(import.meta.url), worktree = dirname(dirname(script))
  receipt.sourceCommit = execFileSync('/usr/bin/git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('/usr/bin/git', ['-C', worktree, 'write-tree'], { encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(script)
  for (const mode of ['default', 'managed']) for (const scope of ['primary', 'worktree']) {
    const label = `codex-${mode}-${scope}`
    const context = JSON.parse(readFileSync(join(contextDir, `${label}-private.json`), 'utf8'))
    const current = JSON.parse(readFileSync(registry, 'utf8')).accounts.find((row: any) => row.id === context.account.id)
    assert.deepEqual(current, context.account)
    assert.equal(current.agent, 'codex'); assert.equal(current.mode, mode)
    assert.ok(context.identity.state === 'known' && context.identity.key === current.identity.key)
    const env: Record<string, string> = { HOME: home }
    for (const name of ['USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL']) if (process.env[name]) env[name] = process.env[name]!
    if (mode === 'managed') {
      assert.equal(current.isolation, 'CODEX_HOME')
      const profile = join(home, '.agent-cockpit/account-profiles', current.id)
      assert.equal(context.env.CODEX_HOME, profile); assert.equal(realpathSync(profile), context.canonicalProfile)
      env.CODEX_HOME = profile
    } else assert.equal(current.isolation, 'none')
    const cwd = scope === 'worktree' ? worktree : join(dirname(dirname(worktree)), 'agent-cockpit')
    assert.equal(context.cwd, cwd); process.chdir(cwd)
    const deadline = Date.now() + 60_000
    let sequence = 0
    const ask = async (method: string, params: unknown): Promise<any> => {
      assert.equal(sha(registry), registryHash, 'Account registry changed during discovery')
      const remaining = deadline - Date.now(); assert.ok(remaining > 0)
      receipt.metadataQueries = Number(receipt.metadataQueries) + 1
      const answer = await queryAppServer(cli, method, params, { env, timeoutMs: Math.min(15_000, remaining), experimentalApi: true })
      attempt!.writePrivate(`${label}-${++sequence}-${method.replaceAll('/', '-')}-private.json`, JSON.stringify(answer))
      assert.equal(answer.error, undefined, 'Native discovery refused; retain evidence and stop without retry')
      assert.equal(sha(registry), registryHash)
      return answer.result
    }
    const identity = codexIdentityFrom(await ask('account/read', { refreshToken: false }))
    assert.ok(identity.state === 'known' && identity.key === current.identity.key)
    const hooks = await ask('hooks/list', { cwds: [cwd] })
    const skills = await ask('skills/list', { cwds: [cwd], forceReload: true })
    const memory = await ask('memory/status', {})
    const finalIdentity = codexIdentityFrom(await ask('account/read', { refreshToken: false }))
    assert.ok(finalIdentity.state === 'known' && finalIdentity.key === current.identity.key, 'Native principal changed during discovery')
    assert.ok(Array.isArray(hooks.data) && Array.isArray(skills.data) && memory && typeof memory === 'object')
    const hookRows = hooks.data.flatMap((entry: any) => entry.hooks ?? [])
    const skillRows = skills.data.flatMap((entry: any) => entry.skills ?? [])
    const skillErrors = skills.data.flatMap((entry: any) => entry.errors ?? [])
    ;(receipt.rows as unknown[]).push({ provider: 'codex', providerVersion: '0.162.1', accountMode: mode, workspaceScope: scope,
      accountGeneration: current.generation, identityMatched: true, hookCount: hookRows.length,
      enabledHooks: hookRows.filter((row: any) => row.enabled === true).length,
      trustedHooks: hookRows.filter((row: any) => row.trustStatus === 'trusted').length,
      skillCount: skillRows.length, enabledSkills: skillRows.filter((row: any) => row.enabled === true).length,
      skillDiscoveryErrors: skillErrors.length, memoryStatusAvailable: true, loadingOrInvocationProven: false })
  }
  receipt.verdict = 'PASS_NATIVE_DISCOVERY_ONLY'
} catch (error) {
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  receipt.limitations = ['Native discovery/status only, not loading, invocation, enforcement or isolation proof',
    'No connector initialization or real account model turn; complete expected inventory not established']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, observedContexts: (receipt.rows as unknown[]).length, modelInputs: 0 }))
}
