// Read-only setup check: no sign-in, agent calls, configuration changes or network requests.
import { execFileSync } from 'node:child_process'
import { arch, platform } from 'node:os'
import { resolveAppPath } from '../electron/shell-path.ts'
import { tailscaleBinary } from '../server/remote/tailscale.ts'

const supported = platform() === 'darwin' && arch() === 'arm64'
console.log(`${supported ? 'OK' : 'NOTE'} Platform: ${platform()} ${arch()}. Packaged MVP support: macOS Apple silicon.`)
const env = { ...process.env, PATH: resolveAppPath().path }
let found = 0
for (const command of ['claude', 'codex', 'agy', 'opencode']) {
  try {
    const version = execFileSync(command, ['--version'], { env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0]
    console.log(`OK ${command}: ${version}`)
    found += 1
  } catch {
    console.log(`MISSING ${command}: install and sign in to this CLI if you want to use it.`)
  }
}
try {
  tailscaleBinary(env.PATH)
  console.log('OK Tailscale is installed (optional, for phone access). Connection and HTTPS setup are checked when phone access is enabled.')
} catch {
  console.log('OPTIONAL Tailscale is not installed. Desktop conversations work without it.')
}
console.log('Authentication and model access are not tested. Open your chosen CLI in a terminal, finish its sign-in, and confirm it can answer a prompt.')
console.log(found ? 'Choose an installed agent in Cockpit. Leave Model blank to use your CLI default.' : 'Install at least one supported agent CLI before starting a conversation.')
process.exitCode = supported && found > 0 ? 0 : 1
