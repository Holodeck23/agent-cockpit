// Explicitly authorized metadata reconciliation; no login, credential copy, profile or project selection change.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { codexIdentityFrom } from '../server/agents/accounts/identity.ts'
import { createAccountStore } from '../server/agents/accounts/store.ts'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { ProbeAttempt } from './lib/w13-completion-probe.ts'

process.umask(0o077)
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
let attempt: ProbeAttempt | undefined
const receipt: Record<string, unknown> = { scenario: 'authorized-default-codex-identity-refresh', verdict: 'BLOCKED',
  modelInputs: 0, credentialPayloadReads: 0, loginChanges: 0, projectSelectionChanges: 0 }
try {
  assert.equal(process.env.COCKPIT_PROOF_AUTHORIZED_REFRESH, '1')
  const home = process.env.HOME ?? '', contextFile = process.env.COCKPIT_PROOF_CONTEXT ?? '', cli = process.env.COCKPIT_W13_CODEX ?? ''
  assert.ok([evidence, privateDir, contextFile, cli].every(isAbsolute))
  const privateRoot = realpathSync(join(home, 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot) && realpathSync(contextFile).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  assert.equal(sha(cli), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const approved = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.equal(approved.account.id, 'default-codex'); assert.equal(approved.account.mode, 'default')
  assert.equal(approved.identity.state, 'known'); assert.equal(approved.env.HOME, home)
  assert.notEqual(approved.identity.key, approved.account.identity.key)
  const state = join(home, '.agent-cockpit'), file = join(state, 'accounts.json'), beforeBytes = readFileSync(file)
  const before = JSON.parse(beforeBytes.toString('utf8'))
  const original = before.accounts.find((row: any) => row.id === 'default-codex')
  assert.deepEqual(original, approved.account, 'Saved account changed since the reviewed mismatch')
  attempt.writePrivate('accounts-before-private.json', beforeBytes)
  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  assert.ok(!processRows.some((line) => line.includes('Cockpit.app/Contents/MacOS/') || /(?:tsx|node).*agent-cockpit\/server\/index/.test(line)),
    'Use the live Cockpit refresh service while sessions exist; offline refresh refuses an active server')
  const env: Record<string, string> = { HOME: home }
  for (const name of ['USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL']) if (process.env[name]) env[name] = process.env[name]!
  process.chdir(approved.cwd)
  const answer = await queryAppServer(cli, 'account/read', { refreshToken: false }, { env, timeoutMs: 15_000 })
  assert.equal(answer.error, undefined)
  const identity = codexIdentityFrom(answer.result)
  attempt.writePrivate('native-identity-private.json', JSON.stringify(identity))
  assert.ok(identity.state === 'known' && identity.key === approved.identity.key, 'Current native login changed since user choice')
  assert.equal(sha(file), createHash('sha256').update(beforeBytes).digest('hex'), 'Registry changed concurrently')
  // Existing store path supplies private atomic replacement and normal generation/revision semantics.
  const updated = createAccountStore(state).observe('default-codex', identity)
  receipt.registryWritePerformed = true
  assert.equal(updated.changed, true)
  assert.equal(updated.account.generation, original.generation + 1)
  const afterBytes = readFileSync(file), after = JSON.parse(afterBytes.toString('utf8'))
  attempt.writePrivate('accounts-after-private.json', afterBytes)
  const expected = { ...before, revision: before.revision + 1, accounts: before.accounts.map((row: any) => row.id === 'default-codex'
    ? { ...row, identity, generation: row.generation + 1, lastKnownKey: identity.key, revision: row.revision + 1 } : row) }
  assert.deepEqual(after, expected, 'Unexpected registry mutation; retain snapshots and do not overwrite again')
  receipt.previousGeneration = original.generation; receipt.generation = updated.account.generation
  receipt.otherAccountsUnchanged = true; receipt.projectSelectionsUnchanged = true; receipt.currentNativeIdentityMatched = true
  receipt.noRunningCockpitServerObserved = true
  receipt.verdict = 'PASS_AUTHORIZED_DEFAULT_IDENTITY_REFRESH'
} catch (error) {
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, previousGeneration: receipt.previousGeneration, generation: receipt.generation }))
}
