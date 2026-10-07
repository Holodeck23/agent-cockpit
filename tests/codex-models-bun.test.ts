import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectManager } from '../server/agents/capabilities/manager.ts'
import { parseCodexModels, probeAgent, type Runner } from '../server/agents/capabilities/probes.ts'
import { queryAppServer, type AppServerQuery } from '../server/agents/codex/app-server-query.ts'
import { updatePlanFor } from '../server/agents/lifecycle/plans.ts'

// First tester on v0.1.5: the Codex model picker was empty (Cockpit never asked Codex for its
// models), and a Bun-installed Codex was taken for npm's and updated through npm, leaving the
// Bun copy old. Models now come from app-server model/list; Bun installs are left to Bun.

const recorded = JSON.parse(readFileSync('tests/fixtures/codex-model-list-0.147.json', 'utf8')) as unknown
const signedIn: Runner = async () => ({ ok: true, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false })

describe('Codex models from model/list', () => {
  it('lists the visible models in Codex’s order, with their names', () => {
    expect(parseCodexModels(recorded)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }, { id: 'gpt-5.5', label: 'GPT-5.5' },
    ])
    expect(parseCodexModels({ data: [{ id: 'secret-preview', hidden: true }, { id: 'bad id; rm' }, { model: 'gpt-x' }] })).toEqual([{ id: 'gpt-x' }])
    expect(parseCodexModels(undefined)).toEqual([])
  })

  it('the capability probe offers them; a failed list says so and still lets you type one', async () => {
    const answers: AppServerQuery = async (_path, method) => (method === 'model/list' ? { result: recorded } : { error: 'unexpected' })
    const probe = await probeAgent('codex', '/x/codex', signedIn, 1000, answers)
    expect(probe.models).toMatchObject({ state: 'supported', source: 'codex app-server model/list' })
    expect(probe.models.value?.map((m) => m.id)).toContain('gpt-5.6-luna')
    expect(probe.auth.state).toBe('signed_in')
    const failed = await probeAgent('codex', '/x/codex', signedIn, 1000, async () => ({ error: 'codex app-server did not answer model/list within 1 s' }))
    expect(failed.models).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/^Codex did not list its models: type a model id.*within 1 s\)$/) })
  })

  it('asks a real app-server process and stops it (stand-in)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-model-list-'))
    const codex = join(dir, 'codex')
    writeFileSync(join(dir, 'answer.json'), JSON.stringify(recorded))
    writeFileSync(codex, `#!/usr/bin/perl
use strict; use warnings; $| = 1;
open(my $f, '<', '${join(dir, 'answer.json')}'); local $/; my $list = <$f>; close $f; $/ = "\\n";
while (my $line = <STDIN>) {
  my ($id) = $line =~ /"id":(\\d+)/; next unless defined $id;
  if ($line =~ /"initialize"/) { print qq({"id":$id,"result":{}}\\n) }
  elsif ($line =~ /"model\\/list"/) { print qq({"id":$id,"result":$list}\\n) }
}
`)
    chmodSync(codex, 0o755)
    const answer = await queryAppServer(codex, 'model/list', {}, { timeoutMs: 15_000 })
    expect(parseCodexModels(answer.result)).toHaveLength(4)
    const missing = await queryAppServer(join(dir, 'none'), 'model/list', {}, { timeoutMs: 2000 })
    expect(missing.error).toMatch(/could not start \(ENOENT\)/)
  }, 20_000)
})

describe('Bun installs (first tester)', () => {
  const home = '/tmp/tester-home'
  it('a Bun global install is Bun’s, not npm’s, for both CLIs', () => {
    expect(detectManager('codex', `${home}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`, home)).toEqual({ kind: 'bun', label: 'bun (global)' })
    expect(detectManager('claude', `${home}/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js`, home)).toEqual({ kind: 'bun', label: 'bun (global)' })
    expect(detectManager('codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', home).kind).toBe('npm')
  })

  it('Cockpit leaves a Bun install’s update to Bun, with the exact command', () => {
    const caps = (agent: 'claude' | 'codex', path: string) => ({
      agent, context: 'default', settings: {}, auth: { state: 'not_checked' as const }, models: { state: 'not_checked' as const },
      manager: { kind: 'bun' as const, label: 'bun (global)' },
      executable: { state: 'found' as const, identity: { command: agent, path, realpath: path, fingerprint: 'f', version: '1' } },
    })
    expect(updatePlanFor(caps('codex', `${home}/.bun/bin/codex`), {})).toEqual({ available: false,
      reason: `Codex at ${home}/.bun/bin/codex was installed with Bun, so Cockpit leaves its update to Bun.`, manual: 'bun add -g @openai/codex@latest' })
    expect(updatePlanFor(caps('claude', `${home}/.bun/bin/claude`), {})).toMatchObject({ available: false, manual: 'bun add -g @anthropic-ai/claude-code@latest' })
  })
})
