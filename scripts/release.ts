// Scripted prerelease, one stage at a time. Each stage checks its own preconditions, so a stage
// can be re-run after a failure without repeating the ones before it.
//
//   npm run release -- prepare 0.1.4   bump package.json + release links; list prose to rewrite
//   npm run release -- build 0.1.4     verify, landing checks, proofs on a proof build of this commit,
//                                      package to release/v0.1.4, SHA256SUMS, isolated install check,
//                                      installed copy: debug flags refused, window-only API
//   npm run release -- publish 0.1.4 --notes notes.md   GitHub prerelease from a pushed main
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
  const proofEnv = (name: string) => ({ COCKPIT_APP: PROOF_APP, COCKPIT_PROOF_DIR: join(EVIDENCE, name) })
  await run('proof-startup.log', 'npx', ['tsx', 'scripts/proof-startup.ts'], proofEnv('proof-startup'))
  await run('proof-recovery.log', 'npx', ['tsx', 'scripts/proof-recovery.ts'], proofEnv('proof-recovery'))
  await run('proof-recovery-legacy.log', 'npx', ['tsx', 'scripts/proof-recovery.ts', '--legacy'], proofEnv('proof-recovery-legacy'))
  await run('proof-window-key.log', 'npx', ['tsx', 'scripts/proof-window-key.ts'], proofEnv('proof-window-key'))

  await run('build-electron-release.log', 'npm', ['run', 'build:electron'], { COCKPIT_RELEASE_BUILD: '1' })
  await run('package.log', 'npx', ['electron-builder', '--mac', '--arm64', `-c.directories.output=release/v${version}`, ...RELEASE_FUSES])
  if (!existsSync(DMG)) fail(`electron-builder did not produce ${DMG}`)
  const dmgSha = sha256(DMG)
  writeFileSync(SUMS, `${dmgSha}  Cockpit-${version}-arm64.dmg\n`)

  const verification = installCheck(dmgSha)
  writeFileSync(join(EVIDENCE, 'install-verification.json'), `${JSON.stringify(verification, null, 2)}\n`)
  if (verification.version !== version || verification.signature !== 'ok' || !verification.asar_match) {
    fail(`install check failed: ${JSON.stringify(verification)}`)
  }
  console.log(`install check: v${verification.version}, signature ok, app.asar matches the packaged build`)
  await run('installed-lockdown.log', 'npx', ['tsx', 'scripts/check-release-lockdown.ts', INSTALLED])

  const bytes = readFileSync(DMG).length
  const landing = readFileSync(LANDING, 'utf8')
  const sized = withLandingSize(landing, bytes)
  console.log(`\nBuilt ${DMG} (${bytes} bytes, sha256 ${dmgSha}). Evidence: ${EVIDENCE}`)
  if (sized !== landing) {
    writeFileSync(LANDING, sized)
    console.log(`landing/index.html DMG size updated to ${landingSizeLabel(bytes)}: commit it before publish.`)
  }
}

interface InstallVerification {
  version: string; signature: string; asar_installed: string; asar_packaged: string
  asar_match: boolean; dmg_sha256: string; dmg_bytes: number
}

/** Mounts the DMG read-only, copies the app to an isolated folder and checks what a user gets. */
function installCheck(dmgSha: string): InstallVerification {
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
  return {
    version: plist.out,
    signature: signature.ok ? 'ok' : signature.out,
    asar_installed: asarInstalled,
    asar_packaged: asarPackaged,
    asar_match: asarInstalled === asarPackaged,
    dmg_sha256: dmgSha,
    dmg_bytes: readFileSync(DMG).length,
  }
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
  const verified = JSON.parse(readFileSync(join(EVIDENCE, 'install-verification.json'), 'utf8')) as InstallVerification
  if (verified.dmg_sha256 !== dmgSha || !verified.asar_match) fail('install-verification.json is for a different DMG: re-run build')
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
