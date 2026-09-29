import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

// Thin wrapper over the `tailscale` CLI. Every call has a timeout: when the
// macOS network extension is not approved or the app is logged out, the CLI
// can wait forever instead of failing.

export interface TailscaleSelf {
  /** This Mac's tailnet name without the trailing dot. */
  readonly hostname: string
  /** The Tailscale login that owns this Mac. */
  readonly login: string
}

export interface Tailscale {
  self(): Promise<TailscaleSelf>
  /** Where that HTTPS port on this Mac's tailnet name is proxied today, if anywhere. */
  serveTarget(hostname: string, httpsPort: number): Promise<string | undefined>
  serve(port: number, httpsPort: number): Promise<void>
  unserve(httpsPort: number): Promise<void>
}

const CANDIDATES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
const TIMEOUT_MS = 15_000

export class TailscaleError extends Error {}

function binary(): string {
  const found = CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new TailscaleError('Tailscale is not installed on this Mac')
  return found
}

function run(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary(), [...args], { timeout: TIMEOUT_MS, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      if (error.killed) return reject(new TailscaleError('Tailscale did not answer. Open the Tailscale menu and check it is connected.'))
      reject(new TailscaleError(`tailscale ${args[0]} failed: ${(stderr || error.message).trim().split('\n')[0]}`))
    })
  })
}

interface StatusJson {
  BackendState?: string
  Self?: { DNSName?: string; UserID?: number }
  User?: Record<string, { LoginName?: string }>
}
interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

export const systemTailscale: Tailscale = {
  async self() {
    const status = JSON.parse(await run(['status', '--json'])) as StatusJson
    if (status.BackendState !== 'Running') throw new TailscaleError('Tailscale is not connected. Log in from the Tailscale menu.')
    const hostname = (status.Self?.DNSName ?? '').replace(/\.$/, '')
    const login = status.User?.[String(status.Self?.UserID)]?.LoginName ?? ''
    if (!hostname || !login) throw new TailscaleError('Tailscale did not report this Mac\'s name. Turn on MagicDNS for your tailnet.')
    return { hostname, login }
  },
  async serveTarget(hostname, httpsPort) {
    const text = await run(['serve', 'status', '--json'])
    const config = (text.trim() ? JSON.parse(text) : {}) as ServeJson
    return config.Web?.[`${hostname}:${httpsPort}`]?.Handlers?.['/']?.Proxy
  },
  async serve(port, httpsPort) {
    await run(['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`])
  },
  async unserve(httpsPort) {
    await run(['serve', `--https=${httpsPort}`, 'off'])
  },
}
