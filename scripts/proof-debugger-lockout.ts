// Run with tsx after COCKPIT_RELEASE_BUILD=1 npm run build:electron.
// Uses the release main bundle with Electron and disposable Cockpit state; never the installed app.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'

const output = process.env.COCKPIT_SECURITY_EVIDENCE
if (!output) throw new Error('Set COCKPIT_SECURITY_EVIDENCE')
const results = []
// Stock development Electron has Node inspector fuses enabled. The packaged release check covers
// --inspect and NODE_OPTIONS; this fixture specifically proves Chromium's debugger lockout.
for (const flag of ['--remote-debugging-port=0', '-remote-debugging-port=0']) {
  const state = mkdtempSync(join(tmpdir(), 'cockpit-debugger-security-'))
  const child = spawn(electron as unknown as string, [resolve('dist-electron/main.cjs'), flag], {
    env: { ...process.env, COCKPIT_HOME: state }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 3000)
  const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject) })
  clearTimeout(timer)
  const debuggerOpened = /DevTools listening|Debugger listening/.test(stderr)
  results.push({ flag, code, timedOut, debuggerOpened, refused: stderr.includes('Cockpit does not start with'),
    pass: code === 1 && !timedOut && !debuggerOpened && stderr.includes('Cockpit does not start with') })
}
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'debugger-lockout.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n')
console.log(JSON.stringify(results))
process.exitCode = results.every((r) => r.pass) ? 0 : 1
