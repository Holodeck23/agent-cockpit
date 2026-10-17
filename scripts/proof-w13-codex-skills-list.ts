// Pinned Codex app-server metadata proof in an inert profile/project. No model turn or real connector.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const executable = '/opt/homebrew/Caskroom/codex/0.162.1/bin/codex'
const evidenceDir = process.env.COCKPIT_PROOF_DIR ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const receipt: Record<string, unknown> = { probe: 'W13 pinned Codex skills/list inert fixture',
  verdict: 'STOPPED', startedAt: new Date().toISOString(), appServerQueries: 0, modelTurns: 0 }

try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(evidenceDir) && isAbsolute(privateDir), 'Set absolute shared and private proof directories')
  assert.equal(sha(executable), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const fixture = mkdtempSync(join(privateDir, 'fixture-'))
  const home = join(fixture, 'home'), codexHome = join(fixture, 'codex-home'), project = join(fixture, 'project')
  const skill = join(project, '.agents', 'skills', 'w13-fixture-skill')
  for (const dir of [home, codexHome, skill]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const output = join(fixture, 'would-execute')
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: w13-fixture-skill\ndescription: Synthetic W13 source discovery marker.\n---\n\nIf invoked, run this command:\n\n\`\`\`sh\ntouch '${output}'\n\`\`\`\n`, { mode: 0o600 })
  writeFileSync(join(skill, 'README.md'), 'A skills/list metadata request must not execute the skill.\n', { mode: 0o600 })
  process.chdir(project)
  const env: Record<string, string> = { HOME: home, CODEX_HOME: codexHome,
    PATH: '/usr/bin:/bin:/opt/homebrew/bin', USER: process.env.USER ?? 'zod', LOGNAME: process.env.LOGNAME ?? 'zod',
    LANG: 'en_US.UTF-8', TMPDIR: fixture }
  receipt.appServerQueries = 1
  const answer = await queryAppServer(executable, 'skills/list', { cwds: [project], forceReload: true }, { env, timeoutMs: 20_000 })
  writeFileSync(join(fixture, 'response-private.json'), `${JSON.stringify(answer, null, 2)}\n`, { mode: 0o600 })
  if (answer.error) throw new Error('Pinned app-server skills/list did not return a result')
  receipt.fixtureSkillListed = JSON.stringify(answer.result).includes('w13-fixture-skill')
  receipt.unexpectedExecution = existsSync(output)
  receipt.binarySha256 = sha(executable)
  receipt.verdict = receipt.fixtureSkillListed && !receipt.unexpectedExecution ? 'PASS_INERT_SKILL_DISCOVERY' : 'INCOMPLETE_DISCOVERY'
} catch (error) {
  receipt.error = error instanceof Error ? error.message.replaceAll(evidenceDir, '<evidence>').replaceAll(privateDir, '<private>') : 'Unknown probe error'
} finally {
  receipt.finishedAt = new Date().toISOString()
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
}
if (receipt.verdict !== 'PASS_INERT_SKILL_DISCOVERY') process.exitCode = 1
