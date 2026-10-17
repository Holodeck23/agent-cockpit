// W13 U2 setup discovery. `static` mode (the default and the only mode so far) reads the expected
// Claude inventory of the default profile and one managed profile for the same workspace, with no
// provider process, initialization or write outside the two evidence folders. Shared evidence holds
// counts and per-kind deltas; names and locators stay in the private folder.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inventoryClaudeSetup, summarizeClaudeInventory, type ClaudeInventory } from '../server/agents/setup/claude-inventory.ts'

const mode = process.argv[2] ?? 'static'
assert.equal(mode, 'static', 'Only static discovery exists; synthetic and live modes are not built yet')
const evidence = process.env.COCKPIT_PROOF_DIR, privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR
const accountId = process.env.COCKPIT_PROOF_ACCOUNT_ID, home = process.env.HOME
assert.ok(evidence && privateDir && accountId && home, 'Set COCKPIT_PROOF_DIR, COCKPIT_PROOF_PRIVATE_DIR and COCKPIT_PROOF_ACCOUNT_ID')
assert.match(accountId, /^[0-9a-f-]{36}$/)
const workspace = process.env.COCKPIT_PROOF_WORKSPACE ?? process.cwd()
for (const dir of [evidence, privateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
const write = (dir: string, name: string, value: unknown): void =>
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

const run = (profileDir: string): ClaudeInventory =>
  inventoryClaudeSetup({ home, profileDir, workspaceRoot: workspace, cwd: workspace, pathEnv: process.env.PATH ?? '' })
const profiles = {
  default: run(join(home, '.claude')),
  managed: run(join(home, '.agent-cockpit', 'account-profiles', accountId)),
}

// What the default profile can load that the managed one cannot, by kind and native name.
const key = (row: ClaudeInventory['capabilities'][number]): string => `${row.kind}\0${row.nativeName}`
const managedKeys = new Set(profiles.managed.capabilities.map(key))
const missing = profiles.default.capabilities.filter((row) => row.enabled && !managedKeys.has(key(row)))
const byKind = (rows: readonly ClaudeInventory['capabilities'][number][]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const row of rows) out[row.kind] = (out[row.kind] ?? 0) + 1
  return out
}

const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '' }
write(evidence, 'expected-inventory-summary.json', {
  mode, source, at: new Date().toISOString(), workspace: 'W13 worktree', pathEnv: 'invoking shell PATH',
  default: summarizeClaudeInventory(profiles.default), managed: summarizeClaudeInventory(profiles.managed),
})
write(evidence, 'discovery-deltas.json', {
  meaning: 'Enabled items the default Claude profile exposes for this workspace that the managed profile does not, matched by kind and native name. Presence, not measured loading.',
  missingFromManaged: byKind(missing), missingTotal: missing.length,
  precedenceMeasured: false,
})
write(privateDir, 'inventory-private.json', {
  missingFromManaged: missing.map((row) => ({ kind: row.kind, name: row.nativeName, unavailable: row.unavailableReason ?? null })),
  problems: { default: profiles.default.problems, managed: profiles.managed.problems },
})
console.log(JSON.stringify({ missingFromManaged: byKind(missing), problems: {
  default: profiles.default.problems.length, managed: profiles.managed.problems.length } }))
