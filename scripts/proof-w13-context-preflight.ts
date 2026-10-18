// Non-generating native identity baseline for the required eight account/workspace contexts.
// Reads registry metadata; never writes accounts, instruction links or credential payloads.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeIdentity } from '../server/agents/accounts/identity.ts'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { ProbeAttempt } from './lib/w13-completion-probe.ts'

process.umask(0o077)
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
let attempt: ProbeAttempt | undefined
const receipt: Record<string, unknown> = { scenario: 'native-eight-context-identity-baseline', verdict: 'BLOCKED',
  modelInputs: 0, credentialPayloadReads: 0, registryWrites: 0, rows: [] }
try {
  const home = process.env.HOME ?? '', descriptor = process.env.COCKPIT_PROOF_CONTEXT ?? ''
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok([evidence, privateDir, descriptor].every(isAbsolute))
  const privateRoot = realpathSync(join(home, 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot) && realpathSync(descriptor).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  const executables = { claude: process.env.COCKPIT_W13_CLAUDE ?? '', codex: process.env.COCKPIT_W13_CODEX ?? '' }
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  assert.equal(sha(executables.claude), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
  assert.equal(sha(executables.codex), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  const registryFile = join(home, '.agent-cockpit/accounts.json'), registryHash = sha(registryFile)
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  const authorizedClaude = JSON.parse(readFileSync(descriptor, 'utf8'))
  const worktree = dirname(dirname(fileURLToPath(import.meta.url)))
  const primary = join(dirname(dirname(worktree)), 'agent-cockpit')
  // The implementation worktree and canonical repository remain intact; no fixture checkout replaces them.
  assert.equal(realpathSync(primary), primary)
  const roots = [{ scope: 'primary', cwd: primary }, { scope: 'worktree', cwd: worktree }]
  receipt.sourceCommit = execFileSync('/usr/bin/git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('/usr/bin/git', ['-C', worktree, 'write-tree'], { encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(fileURLToPath(import.meta.url))
  const rows = receipt.rows as unknown[]
  for (const agent of ['claude', 'codex'] as const) for (const mode of ['default', 'managed'] as const) {
    const matches = registry.accounts.filter((row: any) => row.agent === agent && row.mode === mode)
    assert.equal(matches.length, 1, 'Required exact account context missing or ambiguous')
    const account = matches[0]
    assert.ok(account.identity?.state === 'known' && typeof account.identity.key === 'string')
    const env: Record<string, string> = { HOME: home }
    for (const name of ['USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL']) if (process.env[name]) env[name] = process.env[name]!
    if (mode === 'managed') {
      const literal = join(home, '.agent-cockpit/account-profiles', account.id)
      const info = lstatSync(literal)
      assert.ok(info.isDirectory() || info.isSymbolicLink())
      if (agent === 'claude') {
        assert.equal(account.id, authorizedClaude.accountId)
        assert.equal(literal, authorizedClaude.literalProfileDir)
        assert.equal(realpathSync(literal), authorizedClaude.canonicalProfileDir)
      }
      assert.equal(account.isolation, agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME')
      env[account.isolation] = literal
    }
    for (const root of roots) {
      assert.equal(sha(registryFile), registryHash, 'Account registry changed; stop before another context')
      process.chdir(root.cwd)
      const identity = await observeIdentity(agent, { executable: executables[agent], env, timeoutMs: 15_000,
        query: (executable, method, _params, options) => {
          assert.equal(method, 'account/read')
          return queryAppServer(executable, method, { refreshToken: false }, options)
        } })
      attempt.writePrivate(`${agent}-${mode}-${root.scope}-private.json`, JSON.stringify({ account, env, cwd: root.cwd,
        canonicalProfile: mode === 'managed' ? realpathSync(env[account.isolation]!) : undefined, identity }, null, 2))
      const matched = identity.state === 'known' && identity.key === account.identity.key
      rows.push({ provider: agent, providerVersion: agent === 'claude' ? '2.1.220' : '0.162.1', accountMode: mode,
        workspaceScope: root.scope, accountGeneration: account.generation, identityMatched: matched,
        modelInputs: 0, capabilityLoading: 'NOT_PROVEN' })
      assert.ok(matched, 'Native identity mismatch or unknown; stop with retained evidence and no fallback')
      assert.equal(sha(registryFile), registryHash, 'Account registry changed during preflight')
    }
  }
  receipt.verdict = 'PASS_EIGHT_CONTEXT_IDENTITY_ONLY'
} catch (error) {
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  receipt.limitations = ['Identity preflight only; no model input, capability loading, effect or account isolation canary proof',
    'No registry observation updated; auth/permission/provider walls stop the affected path without retry']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, observedContexts: (receipt.rows as unknown[]).length, modelInputs: 0 }))
}
