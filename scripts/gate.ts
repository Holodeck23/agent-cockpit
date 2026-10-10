// The cumulative release gate (ACCEPTANCE REL-02): every suite in scripts/lib/gate-suites.ts, one at
// a time, against one packaged proof build, `--runs` times in a row. The package is hashed before
// each pass and at the end; a changed package voids the gate. Each suite gets its own evidence
// folder and output file; the summary names the commit, the package, every result and the first
// failure. A failed pass ends the gate (a fix makes a new candidate, which starts again at run 1).
//
//   npx tsx scripts/gate.ts --app release/proof/mac-arm64/Cockpit.app --out <dir> [--runs 3] [--only a,b]
//
// --only runs a subset for diagnosis; its summary can never pass as the release gate.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_SUITES, gateVerdict, lastVerdictLine, suitePassed, type SuiteResult } from './lib/gate-suites.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}
function fail(message: string): never {
  console.error(`gate: ${message}`)
  process.exit(2)
}

const app = resolve(flag('app') ?? join(ROOT, 'release/proof/mac-arm64/Cockpit.app'))
const out = resolve(flag('out') ?? fail('--out <dir> is required'))
const runs = Number(flag('runs') ?? 3)
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a whole number of passes')
const only = flag('only')?.split(',').filter(Boolean)
const suites = only ? GATE_SUITES.filter((suite) => only.includes(suite.name)) : GATE_SUITES
if (only && suites.length !== only.length) fail(`unknown suite in --only: ${only.filter((n) => !GATE_SUITES.some((s) => s.name === n)).join(', ')}`)

const asarPath = join(app, 'Contents/Resources/app.asar')
if (!existsSync(asarPath)) fail(`no packaged app at ${app}`)
for (const suite of suites) {
  for (const need of suite.needs ?? []) if (!existsSync(join(ROOT, need))) fail(`${suite.name} needs ${need} (see its proof's header)`)
}
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const git = (...args: string[]): string => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim()

/** This gate and the processes that started it, whose command lines name the app too (--app). */
function ownAncestry(): Set<number> {
  const parents = new Map(spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]))
  const own = new Set<number>()
  for (let pid: number | undefined = process.pid; pid && pid > 1 && !own.has(pid); pid = parents.get(pid)) own.add(pid)
  return own
}

/** Cockpit proof processes, dev servers and stand-ins still running; recorded, never killed. */
function leftovers(): string[] {
  const own = ownAncestry()
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout
  return ps.split('\n').map((line) => line.trim())
    .filter((line) => (line.includes(app) || /scripts\/fixtures\//.test(line)) && !own.has(Number(line.split(/\s+/)[0])))
    .map((line) => line.slice(0, 200))
}

function runSuite(suite: (typeof GATE_SUITES)[number], run: number): Promise<SuiteResult> {
  const dir = join(out, `run-${run}`, suite.name)
  mkdirSync(dir, { recursive: true })
  const log = createWriteStream(join(dir, 'output.txt'))
  const started = Date.now()
  const args = ['run', suite.script, ...(suite.args ? ['--', ...suite.args] : [])]
  const child = spawn('npm', args, { cwd: ROOT, env: { ...process.env, COCKPIT_APP: app, COCKPIT_PROOF_DIR: dir } })
  let output = ''
  const keep = (chunk: Buffer): void => { output += chunk.toString(); log.write(chunk) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  return new Promise((done) => {
    child.on('close', (exit) => {
      log.end()
      done({ name: suite.name, run, exit, seconds: Math.round((Date.now() - started) / 1000), last: lastVerdictLine(output) })
    })
  })
}

const startAsar = sha256(asarPath)
const record = {
  gate: 'REL-02 cumulative deterministic packaged suite',
  scope: 'Stand-in agents and local fixtures only. Does not cover live providers, the physical phone, '
    + 'the production build (REL-04/05), another Mac (REL-06) or real use (REL-10).',
  subset: only ?? null,
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  app,
  appAsarSha256: startAsar,
  appVersion: spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).stdout.trim(),
  requiredRuns: runs,
  suites: suites.map((suite) => ({ name: suite.name, script: suite.script, args: suite.args ?? [], covers: suite.covers })),
  startedAt: new Date().toISOString(),
  results: [] as SuiteResult[],
  leftovers: [] as Array<{ after: string; processes: string[] }>,
  asarChecks: [] as Array<{ before: number; sha256: string }>,
}
mkdirSync(out, { recursive: true })
const summaryFile = join(out, 'gate.json')
const save = (extra: Record<string, unknown> = {}): void => writeFileSync(summaryFile, `${JSON.stringify({ ...record, ...extra }, null, 2)}\n`)
const line = (text: string): void => { console.log(text); writeFileSync(join(out, 'summary.txt'), `${text}\n`, { flag: 'a' }) }

line(`gate ${record.commit.slice(0, 12)}${record.dirty ? ' (DIRTY TREE)' : ''} · app ${record.appVersion} · app.asar ${startAsar.slice(0, 12)} · ${suites.length} suites × ${runs}`)
let voided = ''
for (let run = 1; run <= runs && !voided; run++) {
  const asar = sha256(asarPath)
  record.asarChecks.push({ before: run, sha256: asar })
  if (asar !== startAsar) { voided = `app.asar changed before run ${run}`; break }
  for (const suite of suites) {
    const result = await runSuite(suite, run)
    record.results.push(result)
    const stray = leftovers()
    if (stray.length) record.leftovers.push({ after: `${suite.name} run ${run}`, processes: stray })
    line(`run ${run} ${suite.name}: exit ${result.exit} ${result.seconds}s ${result.last}`)
    save()
  }
  if (record.results.some((result) => result.run === run && !suitePassed(result))) {
    line(`run ${run} had a failure; the gate stops here (a fix is a new candidate)`)
    break
  }
}
const endAsar = sha256(asarPath)
if (!voided && endAsar !== startAsar) voided = 'app.asar changed during the gate'
const verdict = gateVerdict(record.results, suites.map((suite) => suite.name), runs)
const passed = verdict.passed && !voided && !only && !record.dirty
save({ finishedAt: new Date().toISOString(), endAsarSha256: endAsar, voided: voided || null, verdict: { ...verdict, passed } })
line(`GATE ${passed ? 'PASS' : 'FAIL'}: ${verdict.cleanRuns}/${runs} clean passes${voided ? `; ${voided}` : ''}${record.dirty ? '; dirty tree' : ''}`
  + `${only ? '; subset only' : ''}${verdict.firstFailure ? `; first failure: ${verdict.firstFailure.name} run ${verdict.firstFailure.run} (exit ${verdict.firstFailure.exit}${verdict.firstFailure.last ? `, last verdict line: ${verdict.firstFailure.last}` : ''})` : ''}`)
process.exit(passed ? 0 : 1)
