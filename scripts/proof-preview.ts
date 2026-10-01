// Phase 7 gate, run against the packaged app: the agent opens a local app inside Cockpit,
// receives an isolated PNG of that app, and the person can resize, reload, close and reopen it.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, openProject, startConversation } from './lib/ui.ts'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-preview-proof-'))
writeFileSync(join(dir, 'server.js'), `
const http = require('node:http')
const page = '<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5efe5;font:16px system-ui;color:#172033}.card{width:min(620px,80vw);padding:48px;border-radius:28px;background:white;box-shadow:0 24px 70px #634c2e2b}b{color:#2878ef;font-size:13px;text-transform:uppercase;letter-spacing:.12em}h1{font-size:48px;margin:.25em 0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b8a55;margin-right:8px}</style><main class="card"><b>Phase 7</b><h1>Preview is live.</h1><p><span class="dot"></span>The agent can see this local UI, too.</p></main>'
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page) })
server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port + '/'))
`)

const fixture = join(ROOT, 'scripts/fixtures/preview-agent/claude')
chmodSync(fixture, 0o755)
const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/preview-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

try {
  await openProject(page, dir, 'Preview demo')
  await startConversation(page, 'Start the app, open its preview, and inspect the result.')
  await page.getByRole('complementary', { name: 'App preview' }).waitFor({ timeout: 30_000 })
  const pane = page.getByRole('complementary', { name: 'App preview' })
  check('open_preview targets the embedded pane', await pane.isVisible())
  check('the pane identifies a local URL', await pane.getByText('Local', { exact: true }).isVisible()
    && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(await pane.locator('.preview-address code').textContent() ?? ''))
  check('the running app renders inside Cockpit', await page.frameLocator('.preview-pane iframe').getByText('Preview is live.').isVisible())
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor({ timeout: 30_000 })
  check('the agent received a real PNG inspection', await page.getByText('inspected its PNG: yes', { exact: false }).isVisible())

  const before = (await pane.boundingBox())!.width
  const handle = page.getByRole('button', { name: 'Resize preview' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 5, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 100, box.y + box.height / 2)
  await page.mouse.up()
  const after = (await pane.boundingBox())!.width
  check('the pane resizes from its left edge', after > before + 70, `${before} -> ${after}`)

  await pane.getByRole('button', { name: 'Reload' }).click()
  check('reload keeps the local app visible', await page.frameLocator('.preview-pane iframe').getByText('Preview is live.').isVisible())
  await page.screenshot({ path: join(PROOF_DIR, 'phase-7-preview.png') })
  await pane.getByRole('button', { name: 'Close preview' }).click()
  check('the pane closes without stopping the app', !(await pane.isVisible()))

  await page.getByRole('button', { name: /^Processes/ }).click()
  await page.locator('.process-url').click()
  await page.getByRole('complementary', { name: 'App preview' }).waitFor()
  check('a process URL reopens in the pane', await page.getByRole('complementary', { name: 'App preview' }).isVisible())

  await app.close()
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'phase-7-preview-failure.png') }).catch(() => {})
  await app.close().catch(() => {})
}
finish('PROOF PREVIEW')
