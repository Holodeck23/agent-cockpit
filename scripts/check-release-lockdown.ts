// Checks a RELEASE Cockpit.app the way a user gets it, with no debugger (it refuses one):
//   - it will not start with --remote-debugging-port or --inspect, and nothing listens on those ports;
//   - Node's inspector and NODE_OPTIONS are switched off by the fuses;
//   - started normally, it serves its page, and its API refuses a request from outside the window.
// Usage: npx tsx scripts/check-release-lockdown.ts <path/to/Cockpit.app>   (run by scripts/release.ts)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const app = process.argv[2]
if (!app || !existsSync(join(app, 'Contents/MacOS/Cockpit'))) {
  console.error('usage: tsx scripts/check-release-lockdown.ts <path/to/Cockpit.app>')
  process.exit(1)
}
const executable = join(app, 'Contents/MacOS/Cockpit')
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function launch(args: readonly string[]): { child: ChildProcess; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-lockdown-'))
  const child = spawn(executable, args, { stdio: 'ignore', env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR ?? '/tmp', COCKPIT_HOME: home } })
  return { child, home }
}
const exited = (child: ChildProcess, ms: number): Promise<number | null | 'running'> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => resolve('running'), ms)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  if (await exited(child, 8000) === 'running') child.kill('SIGKILL')
}

const fuses = spawnSync('npx', ['@electron/fuses', 'read', '--app', app], { encoding: 'utf8' })
const fuseText = `${fuses.stdout}${fuses.stderr}`
check('fuse: Node --inspect arguments are disabled', /EnableNodeCliInspectArguments is Disabled/.test(fuseText))
check('fuse: NODE_OPTIONS is disabled', /EnableNodeOptionsEnvironmentVariable is Disabled/.test(fuseText))
check('fuse: RunAsNode stays enabled (the cockpit MCP server needs it)', /RunAsNode is Enabled/.test(fuseText))

for (const [flag, port] of [['--remote-debugging-port=9222', 9222], ['--inspect=9229', 9229]] as const) {
  const busy = await listening(port)
  const { child } = launch([flag])
  const code = await exited(child, 15_000)
  const open = await listening(port)
  await stop(child)
  check(`refuses to start with ${flag}`, code !== 'running' && code !== 0 && !open, `exit ${code}, port ${port} ${open ? 'OPEN' : 'closed'}${busy ? ' (was busy before launch)' : ''}`)
}

const { child, home } = launch([])
try {
  const portFile = join(home, 'app-port')
  const end = Date.now() + 30_000
  while (!existsSync(portFile) && Date.now() < end) await sleep(250)
  const port = existsSync(portFile) ? Number(readFileSync(portFile, 'utf8').trim()) : 0
  check('starts normally without debug flags', port > 0, `port ${port}`)
  if (port > 0) {
    const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, () => 0)
    check('serves its page', page === 200, `status ${page}`)
    const api = await fetch(`http://127.0.0.1:${port}/api/threads`, { headers: { origin: `http://127.0.0.1:${port}` } }).then((r) => r.status, () => 0)
    check('its API refuses a forged request from outside the window', api === 403, `status ${api}`)
  }
} finally {
  await stop(child)
}

console.log(failed === 0 ? 'release lockdown PASS' : `release lockdown FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
