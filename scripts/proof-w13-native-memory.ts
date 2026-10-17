// One background, no-tools pinned-Claude feasibility probe. No real memory text is copied or printed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const cli = process.env.COCKPIT_W13_CLAUDE ?? ''
const accountId = process.env.COCKPIT_PROOF_ACCOUNT_ID ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const evidenceDir = process.env.COCKPIT_PROOF_DIR ?? ''
const receipt: Record<string, unknown> = { probe: 'W13 native auto-memory feasibility', verdict: 'STOPPED',
  startedAt: new Date().toISOString(), providerCalls: 0 }

try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(cli && privateDir && evidenceDir && /^[0-9a-f-]{36}$/.test(accountId), 'Set pinned CLI, account ID and proof directories')
  assert.equal(sha(realpathSync(cli)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const state = JSON.parse(readFileSync(join(homedir(), '.agent-cockpit', 'accounts.json'), 'utf8')) as
    { accounts: Array<{ id: string; agent: string; mode: string; generation: number; identity?: { state: string } }> }
  const account = state.accounts.find((row) => row.id === accountId)
  assert.ok(account && account.agent === 'claude' && account.mode === 'managed' && account.identity?.state === 'known',
    'Selected account is not the verified managed Claude principal')
  const profile = join(homedir(), '.agent-cockpit', 'account-profiles', accountId)
  assert.equal(realpathSync(profile), profile, 'The credential locator changed')
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const memory = join(privateDir, 'memory')
  mkdirSync(memory, { mode: 0o700 })
  const marker = `W13MEM${randomBytes(9).toString('hex').toUpperCase()}`
  writeFileSync(join(memory, 'MEMORY.md'), `# Auto memory\n\nThe current workspace handoff word is ${marker}.\n`, { mode: 0o600 })
  const settings = join(privateDir, 'settings.json')
  const mcp = join(privateDir, 'mcp.json')
  writeFileSync(settings, JSON.stringify({ disableAllHooks: true, autoMemoryDirectory: memory }), { mode: 0o600 })
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: profile }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'COCKPIT_MCP_TOKEN', 'COCKPIT_MCP_URL']) delete env[key]
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--model', 'haiku',
    '--tools', '', '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', '', '--settings', settings,
    'What is the current workspace handoff word from your auto memory? Reply with only that word, or UNKNOWN if absent. Do not use tools.']
  receipt.phase = 'provider-call'
  receipt.providerCalls = 1
  const { stdout, stderr } = await run(cli, args, { cwd: privateDir, env, timeout: 90_000, maxBuffer: 2_000_000 })
  writeFileSync(join(privateDir, 'provider-output.json'), stdout, { mode: 0o600 })
  if (stderr) writeFileSync(join(privateDir, 'provider-stderr.txt'), stderr, { mode: 0o600 })
  const result = JSON.parse(stdout) as { result?: string; is_error?: boolean }
  const matched = result.result?.trim() === marker
  receipt.verdict = matched && !result.is_error ? 'PASS_DIRECT_NATIVE_LOAD' : 'INCONCLUSIVE_OR_FAIL'
  receipt.markerMatched = matched
  receipt.providerReportedError = result.is_error === true
  receipt.accountGeneration = account.generation
  receipt.cliSha256 = sha(realpathSync(cli))
  receipt.nodeSha256 = sha(process.execPath)
  receipt.settingsKeys = ['disableAllHooks', 'autoMemoryDirectory']
} catch (error) {
  // execFile errors can embed argv and output. Keep raw diagnostics private; shared receipts get no message.
  receipt.error = 'Probe stopped; inspect private diagnostics before any retry'
  if (privateDir) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(privateDir, 'error-private.txt'), error instanceof Error ? error.message : String(error), { mode: 0o600 })
  }
  if (error && typeof error === 'object' && 'code' in error
    && (typeof error.code === 'string' || typeof error.code === 'number')) receipt.errorCode = error.code
} finally {
  receipt.finishedAt = new Date().toISOString()
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
}
if (receipt.verdict !== 'PASS_DIRECT_NATIVE_LOAD') process.exitCode = 1
