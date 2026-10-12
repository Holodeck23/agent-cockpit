// Run as a bundled Electron main script. All destinations are synthetic loopback fixtures.
import { app } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserService } from '../electron/browser-service.ts'
import { createBrowserAgentHost } from '../electron/browser-agent-host.ts'
import { createBrowserAgent } from '../server/browser/agent.ts'
import { createBrowserLeases } from '../server/browser/agent-policy.ts'
import { guardLocalPreview } from '../electron/preview-navigation.ts'

const state = mkdtempSync(join(tmpdir(), 'cockpit-navigation-security-'))
app.setPath('userData', state)
app.commandLine.appendSwitch('host-resolver-rules', 'MAP security-fixture.test 127.0.0.1')
app.commandLine.appendSwitch('no-proxy-server')
const output = process.env.COCKPIT_SECURITY_EVIDENCE
if (!output) throw new Error('Set COCKPIT_SECURITY_EVIDENCE to an evidence directory')
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await pause(20)
  if (!check()) throw new Error('Fixture timed out')
}

void app.whenReady().then(async () => {
  const watchdog = setTimeout(() => app.exit(2), 45_000)
  const results: Array<{ name: string; pass: boolean; hits: number; approvals: number }> = []
  let remote = ''
  let hits = 0
  const server = createServer((req, res) => {
    if (req.headers.host?.startsWith('security-fixture.test:')) {
      if (req.url === '/action') hits++
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Synthetic destination</h1>'); return
    }
    if (req.url === '/redirect') { res.writeHead(302, { location: `${remote}/action` }); res.end(); return }
    const script = req.url === '/popup'
      ? `setTimeout(() => window.open(${JSON.stringify(`${remote}/action`)}), 400)`
      : req.url === '/delayed' || req.url === '/stopped'
        ? `setTimeout(() => { location.href = ${JSON.stringify(`${remote}/action`)} }, 400)` : ''
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<h1>Local fixture</h1><script>${script}</script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  remote = `http://security-fixture.test:${port}`
  const local = `http://127.0.0.1:${port}`
  const service = createBrowserService({ window: () => undefined, cockpitPorts: () => [], publish: () => {} })
  const host = createBrowserAgentHost(service)
  try {
    for (const scenario of ['redirect-deny', 'redirect-allow', 'delayed', 'popup', 'stopped', 'abort-pending', 'stop-pending']) {
      hits = 0
      let approvals = 0
      let run: string | undefined = 'run'
      let answer: (() => void) | undefined
      const controller = new AbortController()
      const key = `thread:${scenario}`
      const grant = { threadId: scenario, projectPath: state, cwd: state }
      const agent = createBrowserAgent({ host: () => host, leases: createBrowserLeases(), cockpitPorts: () => [], currentRun: () => run,
        approve: async () => {
          approvals++
          await new Promise<void>((resolve) => { answer = resolve })
          if (!['redirect-allow', 'abort-pending', 'stop-pending'].includes(scenario)) throw new Error('Denied by synthetic test user')
          return 'allow'
        },
      })
      const route = scenario.startsWith('redirect') || scenario.endsWith('-pending') ? '/redirect' : `/${scenario}`
      const operation = agent.handle(grant, 'navigate', { url: `${local}${route}` }, controller.signal).catch(() => undefined)
      if (scenario === 'stopped') {
        await operation
        run = undefined
        await pause(800)
        results.push({ name: scenario, pass: hits === 0 && approvals === 0, hits, approvals })
      } else {
        await until(() => approvals > 0 || (!scenario.startsWith('redirect') && hits > 0))
        const before = hits
        if (scenario === 'abort-pending') controller.abort()
        if (scenario === 'stop-pending') run = undefined
        answer?.()
        await operation
        if (scenario === 'redirect-allow') await until(() => hits > 0)
        else await pause(200)
        results.push({ name: scenario, pass: before === 0 && approvals === 1 && (scenario === 'redirect-allow' ? hits === 1 : hits === 0), hits, approvals })
      }
      service.close(key)
    }
    for (const route of ['redirect', 'delayed', 'popup']) {
      hits = 0
      const key = `thread:preview-${route}`
      guardLocalPreview(host, key, () => [])
      await host.ensure(key, state)
      await host.goto(key, `${local}/${route}`).catch(() => undefined)
      await pause(800)
      results.push({ name: `preview-${route}`, pass: hits === 0, hits, approvals: 0 })
      service.close(key)
    }
    // Explicit human browser navigation remains available after a stopped agent's guard.
    hits = 0
    const manualKey = 'thread:manual'
    host.guardNavigation(manualKey, async () => { throw new Error('Stopped run') })
    await host.ensure(manualKey, state)
    await service.open(manualKey, state, `${remote}/action`)
    await until(() => hits === 1)
    results.push({ name: 'explicit-human-navigation', pass: hits === 1, hits, approvals: 0 })
    service.close(manualKey)
    // Restoring an evicted page is also a request and must pass the newly installed guard.
    hits = 0
    const restoreService = createBrowserService({ window: () => undefined, cockpitPorts: () => [], publish: () => {}, limits: { maxIdle: 0, idleMs: 0, maxTotal: 8 } })
    const restoreHost = createBrowserAgentHost(restoreService)
    const restoreKey = 'thread:restore'
    try {
      await restoreService.open(restoreKey, state, `${remote}/action`)
      await until(() => hits === 1 && !restoreService.state(restoreKey)?.loading)
      await restoreService.sweep()
      const evicted = !restoreService.state(restoreKey)
      hits = 0
      guardLocalPreview(restoreHost, restoreKey, () => [])
      await restoreHost.ensure(restoreKey, state)
      await pause(400)
      results.push({ name: 'restored-page', pass: evicted && hits === 0, hits, approvals: 0 })
    } finally { restoreService.close(restoreKey); restoreService.dispose() }
    mkdirSync(output, { recursive: true })
    const result = { at: new Date().toISOString(), electron: process.versions.electron, results }
    writeFileSync(join(output, 'browser-navigation.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
    process.exitCode = results.every((r) => r.pass) ? 0 : 1
  } finally {
    clearTimeout(watchdog)
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.exit(Number(process.exitCode ?? 1))
  }
}).catch((error) => { console.error(error); app.exit(1) })
