// Scripted prerelease, one stage at a time. Each stage checks its own preconditions, so a stage
// can be re-run after a failure without repeating the ones before it.
//
//   npm run release -- prepare 0.1.4   bump package.json + release links; list prose to rewrite
//   npm run release -- build 0.1.4     verify, landing checks, the cumulative gate (scripts/gate.ts,
//                                      3 passes) on a proof build of this commit, package to
//                                      release/v0.1.4, SHA256SUMS, isolated install check,
//                                      installed copy: debug flags refused, window-only API
//                                      (--gate-runs N for a dry run; publish needs 3)
//   npm run release -- publish 0.1.4 --notes notes.md   GitHub prerelease from a pushed main;
//                                      refuses without a passed 3-run gate for this source
//   npm run release -- deploy 0.1.4    Vercel landing deploy, live page check, live update feed
//
// --evidence <dir> collects logs and screenshots (default release/v<version>/evidence).
// Packaging writes to release/v<version>, never release/mac-arm64, which may be the running app.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpReleaseLinks, isNewerVersion, landingSizeLabel, parseVersion, staleMentions, withLandingSize } from './lib/release.ts'
import {
  createReleaseCandidateRecord,
  isAllowedPostBuildChange,
  releaseCandidateBindingErrors,
  type CandidateArtifactFacts,
  type CandidateGateRecord,
  type CandidateInstallVerification,
} from './lib/release-candidate.ts'
import { hashPackageTree } from './lib/package-hash.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO = 'Holodeck23/agent-cockpit'
const SITE = 'https://agent-cockpit-theta.vercel.app'
const VERCEL = ['deploy', 'landing', '--prod', '--yes', '--project', 'prj_UW9WKWGF9SHNckMf2FiqLNpGiHtZ', '--scope', 'davids-projects-3fd8f18a']
const LINKED_FILES = ['README.md', 'landing/index.html', 'landing/README.md']
const LANDING = join(ROOT, 'landing/index.html')

const [stage, version] = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

if (!stage || !['prepare', 'build', 'publish', 'deploy'].includes(stage) || !version || !parseVersion(version)) {
  fail('usage: npm run release -- <prepare|build|publish|deploy> <x.y.z> [--notes file] [--evidence dir]')
}

const OUT = join(ROOT, 'release', `v${version}`)
const DMG = join(OUT, `Cockpit-${version}-arm64.dmg`)
const SUMS = join(OUT, 'SHA256SUMS')
const EVIDENCE = resolve(flag('evidence') ?? join(OUT, 'evidence'))
const INSTALLED = join(OUT, 'installed', 'Cockpit.app')
const PROOF_APP = join(OUT, 'proof', 'mac-arm64', 'Cockpit.app')
const PRODUCTION_APP = join(OUT, 'mac-arm64', 'Cockpit.app')
const GATE = join(EVIDENCE, 'gate')
const CANDIDATE_BINDING = join(EVIDENCE, 'candidate-binding.json')
// Three consecutive passes is the release gate (ACCEPTANCE REL-02). Fewer is a dry run publish refuses.
const GATE_RUNS = Number(flag('gate-runs') ?? 3)
const REQUIRED_GATE_RUNS = 3
// Node ignores --inspect and NODE_OPTIONS in the release app. RunAsNode stays on: each agent's
// cockpit MCP server runs on the app's own binary with ELECTRON_RUN_AS_NODE (electron/main.ts).
const RELEASE_FUSES = ['-c.electronFuses.enableNodeCliInspectArguments=false', '-c.electronFuses.enableNodeOptionsEnvironmentVariable=false']

const git = (...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
const packageVersion = (): string => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const appVersion = (app: string): string => {
  const result = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' })
  if (result.status !== 0) fail(`cannot read version from ${app}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** Runs a command with output streamed to the terminal and to <evidence>/<log>. */
function run(log: string, command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<string> {
  mkdirSync(EVIDENCE, { recursive: true })
  console.log(`\n▶ ${command} ${args.join(' ')}  (log: ${log})`)
  const file = createWriteStream(join(EVIDENCE, log))
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } })
  let output = ''
  const tee = (chunk: Buffer, to: NodeJS.WriteStream): void => {
    output += chunk.toString()
    to.write(chunk)
    file.write(chunk)
  }
  child.stdout.on('data', (chunk: Buffer) => tee(chunk, process.stdout))
  child.stderr.on('data', (chunk: Buffer) => tee(chunk, process.stderr))
  return new Promise((resolveRun) => {
    child.on('close', (code) => {
      file.end()
      if (code !== 0) fail(`${command} ${args.join(' ')} exited ${code}; see ${join(EVIDENCE, log)}`)
      resolveRun(output)
    })
  })
}

function requireCleanTree(): void {
  const dirty = git('status', '--porcelain')
  if (dirty) fail(`working tree is not clean:\n${dirty}`)
}

function requireTagAbsent(): void {
  if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists locally`)
  if (git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`)) fail(`tag v${version} already exists on origin`)
}

function prepare(): void {
  const current = packageVersion()
  if (!isNewerVersion(version!, current)) fail(`${version} is not newer than package.json ${current}`)
  requireCleanTree()
  requireTagAbsent()
  const bumped = spawnSync('npm', ['version', version!, '--no-git-tag-version'], { cwd: ROOT, encoding: 'utf8' })
  if (bumped.status !== 0) fail(`npm version failed: ${bumped.stderr}`)
  console.log(`package.json and package-lock.json: ${current} → ${version}`)
  for (const name of LINKED_FILES) {
    const path = join(ROOT, name)
    const text = bumpReleaseLinks(readFileSync(path, 'utf8'), current, version!)
    writeFileSync(path, text)
    const stale = staleMentions(text, current)
    console.log(`${name}: release links moved to v${version}${stale.length ? `; ${stale.length} line(s) still name ${current}:` : ''}`)
    for (const mention of stale) console.log(`  ${name}:${mention.line}  ${mention.text.slice(0, 160)}`)
  }
  console.log('\nRewrite the listed prose for this release, update docs/PLAN.md, then commit "release: prepare v' + version + '".')
}

async function build(): Promise<void> {
  if (packageVersion() !== version) fail(`package.json is ${packageVersion()}; run prepare ${version} first`)
  requireCleanTree()
  requireTagAbsent()
  await run('verify.log', 'npm', ['run', 'verify'])
  await run('check-installers.log', 'npm', ['run', 'check:installers'])
  await run('landing-render.log', 'node', ['landing/check-render.mjs', 'landing/index.html', '--width', '390,768,1280'])
  await run('landing-verify.log', 'node', ['landing/verify.mjs', join(EVIDENCE, 'landing-local')])

  // Clear earlier build outputs but keep evidence/, which already holds this run's verify logs.
  for (const entry of existsSync(OUT) ? readdirSync(OUT) : []) {
    if (join(OUT, entry) !== EVIDENCE) rmSync(join(OUT, entry), { recursive: true, force: true })
  }
  // The release build refuses debuggers (electron/debug-flags.ts), and Playwright drives the app
  // through one, so the Playwright proofs run on a proof build of the same commit, made first.
  await run('package-proof.log', 'npx', ['electron-builder', '--mac', 'dir', '--arm64', `-c.directories.output=release/v${version}/proof`])
  // The cumulative gate (REL-02): every required deterministic proof, GATE_RUNS passes in a row on
  // this one proof package (scripts/lib/gate-suites.ts). It replaces the four proofs this stage used to
  // run, which are in it. publish refuses without a passed gate for this commit.
  rmSync(GATE, { recursive: true, force: true })
  await run('gate.log', 'npx', ['tsx', 'scripts/gate.ts', '--app', PROOF_APP, '--out', GATE, '--runs', String(GATE_RUNS)])

  await run('build-electron-release.log', 'npm', ['run', 'build:electron'], { COCKPIT_RELEASE_BUILD: '1' })
  await run('package.log', 'npx', ['electron-builder', '--mac', '--arm64', `-c.directories.output=release/v${version}`, ...RELEASE_FUSES])
  if (!existsSync(DMG)) fail(`electron-builder did not produce ${DMG}`)
  const dmgSha = sha256(DMG)
  writeFileSync(SUMS, `${dmgSha}  Cockpit-${version}-arm64.dmg\n`)

  const verification = installCheck(dmgSha)
  writeFileSync(join(EVIDENCE, 'install-verification.json'), `${JSON.stringify(verification, null, 2)}\n`)
  if (verification.version !== version || verification.signature !== 'ok' || !verification.asar_match || !verification.package_match) {
    fail(`install check failed: ${JSON.stringify(verification)}`)
  }
  console.log(`install check: v${verification.version}, signature ok, app.asar matches the packaged build`)
  await run('installed-lockdown.log', 'npx', ['tsx', 'scripts/check-release-lockdown.ts', INSTALLED])
  writeCandidateBinding(verification)

  const bytes = readFileSync(DMG).length
  const landing = readFileSync(LANDING, 'utf8')
  const sized = withLandingSize(landing, bytes)
  console.log(`\nBuilt ${DMG} (${bytes} bytes, sha256 ${dmgSha}). Evidence: ${EVIDENCE}`)
  if (sized !== landing) {
    writeFileSync(LANDING, sized)
    console.log(`landing/index.html DMG size updated to ${landingSizeLabel(bytes)}: commit it before publish.`)
  }
}

/** Mounts the DMG read-only, copies the app to an isolated folder and checks what a user gets. */
function installCheck(dmgSha: string): CandidateInstallVerification {
  const mount = mkdtempSync(join(tmpdir(), 'cockpit-release-mount-'))
  const sh = (command: string, args: string[]): { ok: boolean; out: string } => {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() }
  }
  const attached = sh('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, DMG])
  if (!attached.ok) fail(`hdiutil attach failed: ${attached.out}`)
  try {
    rmSync(join(OUT, 'installed'), { recursive: true, force: true })
    mkdirSync(join(OUT, 'installed'), { recursive: true })
    const copied = sh('ditto', [join(mount, 'Cockpit.app'), INSTALLED])
    if (!copied.ok) fail(`ditto failed: ${copied.out}`)
  } finally {
    sh('hdiutil', ['detach', mount])
  }
  const plist = sh('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(INSTALLED, 'Contents/Info.plist')])
  const signature = sh('codesign', ['--verify', '--deep', '--strict', INSTALLED])
  const asarInstalled = sha256(join(INSTALLED, 'Contents/Resources/app.asar'))
  const asarPackaged = sha256(join(OUT, 'mac-arm64/Cockpit.app/Contents/Resources/app.asar'))
  const packageInstalled = hashPackageTree(INSTALLED)
  const packagePackaged = hashPackageTree(PRODUCTION_APP)
  return {
    version: plist.out,
    signature: signature.ok ? 'ok' : signature.out,
    asar_installed: asarInstalled,
    asar_packaged: asarPackaged,
    asar_match: asarInstalled === asarPackaged,
    package_installed: packageInstalled,
    package_packaged: packagePackaged,
    package_match: packageInstalled === packagePackaged,
    dmg_sha256: dmgSha,
    dmg_bytes: readFileSync(DMG).length,
  }
}

function candidateFacts(verification: CandidateInstallVerification): CandidateArtifactFacts {
  const gateFile = join(GATE, 'gate.json')
  const required = [
    gateFile,
    join(PROOF_APP, 'Contents/Resources/app.asar'),
    join(PRODUCTION_APP, 'Contents/Resources/app.asar'),
    join(INSTALLED, 'Contents/Resources/app.asar'),
  ]
  for (const path of required) if (!existsSync(path)) fail(`missing candidate artifact ${path}: re-run build`)
  return {
    version: version!,
    proofPackage: {
      path: `release/v${version}/proof/mac-arm64/Cockpit.app`,
      packageSha256: hashPackageTree(PROOF_APP),
      appAsarSha256: sha256(join(PROOF_APP, 'Contents/Resources/app.asar')),
      version: appVersion(PROOF_APP),
    },
    productionPackage: {
      path: `release/v${version}/mac-arm64/Cockpit.app`,
      packageSha256: hashPackageTree(PRODUCTION_APP),
      appAsarSha256: sha256(join(PRODUCTION_APP, 'Contents/Resources/app.asar')),
      version: appVersion(PRODUCTION_APP),
    },
    installer: { path: `release/v${version}/Cockpit-${version}-arm64.dmg`, sha256: sha256(DMG), bytes: readFileSync(DMG).length },
    installedAppPackageSha256: hashPackageTree(INSTALLED),
    installedAppAsarSha256: sha256(join(INSTALLED, 'Contents/Resources/app.asar')),
    installVerification: verification,
    gate: JSON.parse(readFileSync(gateFile, 'utf8')) as CandidateGateRecord,
    gatePath: gateFile,
    gateSha256: sha256(gateFile),
  }
}

function writeCandidateBinding(verification: CandidateInstallVerification): void {
  const facts = candidateFacts(verification)
  const record = createReleaseCandidateRecord(facts)
  const errors = releaseCandidateBindingErrors(record, facts, REQUIRED_GATE_RUNS)
  if (errors.length) fail(`candidate binding is inconsistent:\n- ${errors.join('\n- ')}`)
  writeFileSync(CANDIDATE_BINDING, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`candidate binding: ${CANDIDATE_BINDING} (source ${record.sourceRevision.slice(0, 12)})`)
}

async function publish(): Promise<void> {
  const notes = flag('notes')
  if (!notes || !existsSync(notes)) fail('publish needs --notes <file> with the release notes')
  if (packageVersion() !== version) fail(`package.json is ${packageVersion()}, not ${version}`)
  requireCleanTree()
  requireTagAbsent()
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('publish from main (merge the wave PR first)')
  git('fetch', '--quiet', 'origin', 'main')
  const head = git('rev-parse', 'HEAD')
  if (head !== git('rev-parse', 'origin/main')) fail('HEAD is not origin/main: push or pull first')
  if (!existsSync(DMG) || !existsSync(SUMS)) fail(`missing ${DMG} or SHA256SUMS: run build first`)
  const dmgSha = sha256(DMG)
  if (!readFileSync(SUMS, 'utf8').startsWith(dmgSha)) fail('SHA256SUMS does not match the DMG')
  const installFile = join(EVIDENCE, 'install-verification.json')
  const gateFile = join(GATE, 'gate.json')
  for (const path of [installFile, gateFile, CANDIDATE_BINDING]) if (!existsSync(path)) fail(`missing ${path}: re-run build`)
  const verified = JSON.parse(readFileSync(installFile, 'utf8')) as CandidateInstallVerification
  const facts = candidateFacts(verified)
  const binding = JSON.parse(readFileSync(CANDIDATE_BINDING, 'utf8')) as unknown
  const bindingErrors = releaseCandidateBindingErrors(binding, facts, REQUIRED_GATE_RUNS)
  if (bindingErrors.length) fail(`candidate binding is missing, stale or mismatched:\n- ${bindingErrors.join('\n- ')}`)
  const sourceRevision = (binding as { sourceRevision: string }).sourceRevision
  // After the gate only what never reaches the app may change: the landing page (its DMG size) and
  // Markdown (the release record with this build's hashes). Anything else is untested source.
  const since = git('diff', '--name-only', sourceRevision, head).split('\n').filter(Boolean)
  const untested = since.filter((file) => !isAllowedPostBuildChange(file))
  if (untested.length) fail(`source changed since the bound commit ${sourceRevision.slice(0, 12)}: ${untested.join(', ')}`)
  if (!readFileSync(LANDING, 'utf8').includes(`· DMG · ${landingSizeLabel(readFileSync(DMG).length)}`)) {
    fail('landing/index.html does not state this DMG size: commit the build stage change')
  }

  await run('gh-release.log', 'gh', ['release', 'create', `v${version}`, DMG, SUMS, '-R', REPO, '--prerelease',
    '--target', head, '--title', `Cockpit v${version}`, '--notes-file', notes])
  const api = await run('release-api.json', 'gh', ['api', `repos/${REPO}/releases/tags/v${version}`])
  const release = JSON.parse(api) as { prerelease: boolean; assets: { name: string; size: number; digest?: string }[] }
  const asset = release.assets.find((a) => a.name === `Cockpit-${version}-arm64.dmg`)
  if (!release.prerelease || !asset) fail('published release is missing its DMG or is not a prerelease')
  if (asset.size !== verified.dmg_bytes) fail(`uploaded DMG is ${asset.size} bytes, local is ${verified.dmg_bytes}`)
  if (asset.digest && asset.digest !== `sha256:${dmgSha}`) fail(`GitHub digest ${asset.digest} does not match ${dmgSha}`)
  console.log(`\nPublished v${version} at ${head}: https://github.com/${REPO}/releases/tag/v${version}` +
    ` (asset digest ${asset.digest ? 'matches' : 'not reported'})`)
}

async function deploy(): Promise<void> {
  if (packageVersion() !== version) fail(`package.json is ${packageVersion()}, not ${version}`)
  if (!git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`)) fail(`v${version} is not published yet`)
  await run('vercel-deploy.log', 'npx', ['--yes', 'vercel@latest', ...VERCEL])
  await run('landing-hosted-verify.log', 'node', ['landing/verify.mjs', join(EVIDENCE, 'landing-live')], { LANDING_URL: SITE })
  const feed = await run('smoke-updates-live.log', 'npx', ['tsx', 'scripts/smoke-updates.ts'])
  if (!feed.includes(`latest ${version} ·`)) fail(`the live update feed does not offer ${version} yet`)
  console.log(`\nLive: ${SITE} advertises v${version}; Check for Updates offers it.`)
}

const stages: Record<string, () => void | Promise<void>> = { prepare, build, publish, deploy }
await stages[stage]!()
