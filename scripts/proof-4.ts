// Phase 4 gate, run against the PACKAGED app (npm run package first): `npm run proof:mcp`.
// A real agent thread (Haiku by default, --codex selects Codex) in a small web project is asked, in plain words that name no tools, to get
// the dev server running and show the site. It has to start the server through the cockpit MCP,
// read its log, and open the preview itself. The preview is captured (not opened) by swapping
// shell.openExternal in the main process. Then: the header chip, Stop from the UI, a restart,
// and quitting the app with the dev server running must leave none of its processes behind.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { DEV_PROMPT, makeDevProject } from './lib/dev-fixture.ts'
import { chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const agent = process.argv.includes('--codex') ? 'codex' : 'claude'
const model = agent === 'codex' ? (process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna') : 'haiku'

mkdirSync(PROOF_DIR, { recursive: true })
const { check, finish } = checker()

interface ProcessInfo {
  id: string
  name: string
  status: string
  pid?: number
  url?: string
  projectPath: string
}
interface StoredEvent {
  event: { kind: string; name?: string; input?: unknown; id?: string; toolUseId?: string; content?: unknown }
}

const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>

/** Polls from Node: page.waitForFunction does not await an async predicate (a Promise is truthy). */
async function waitUntil<T>(page: Page, what: string, read: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(500)
  }
}

/** Clicks Allow on every approval card until the turn ends; returns the tools that asked. */
async function approveUntilDone(page: Page, threadId: string, screenshot?: string): Promise<string[]> {
  const asked: string[] = []
  await waitUntil(page, 'the turn to finish', async () => {
    const card = page.locator('.approval.open').first()
    if (await card.isVisible()) {
      const tool = ((await card.locator('.approval-title strong').nth(1).textContent()) ?? '').trim()
      const detail = ((await card.locator('.approval-detail').textContent()) ?? '').trim()
      asked.push(tool === 'Start a process' ? tool : `${tool}: ${detail}`)
      if (screenshot && asked.length === 1) await page.screenshot({ path: join(PROOF_DIR, screenshot) })
      await card.getByRole('button', { name: 'Allow', exact: true }).click()
      return undefined
    }
    const { status } = await getJson<{ status: string }>(page, `/api/threads/${threadId}/events`)
    return status === 'done' || status === 'error' ? status : undefined
  })
  return asked
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const groupMembers = (pgid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

const project = makeDevProject('cockpit-4-')
const app = await launchPackagedApp()
const appPid = app.process().pid ?? 0
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

// Capture previews instead of opening a browser. main.ts calls shell.openExternal late-bound.
await app.evaluate(({ shell }) => {
  const opened: string[] = []
  ;(globalThis as { __opened?: string[] }).__opened = opened
  shell.openExternal = async (url: string) => void opened.push(url)
})
const openedUrls = (): Promise<string[]> => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

await openProject(page, project, 'Sprout site')
await chooseAgent(page, { agent, model })
await startConversation(page, DEV_PROMPT)
const threadId = await waitUntil(page, 'the thread', async () =>
  (await getJson<Array<{ meta: { id: string; projectPath: string } }>>(page, '/api/threads')).find((t) => t.meta.projectPath === project)?.meta.id,
)

const asked = await approveUntilDone(page, threadId, 'phase-4-approval.png')
check('turn finished', (await headStatus(page).textContent()) === 'Ready', (await headStatus(page).textContent()) ?? '')
// The agent may also use Bash, which asks in manual mode like any command. What matters here: starting a
// process asks, and the read-only cockpit tools (list, read log, preview) never do.
const READ_ONLY = ['List processes', 'Read process output', 'Open a preview', 'list_processes', 'read_process_output', 'open_preview']
check('starting a process asked for approval', asked.some((tool) => tool === 'Start a process' || (tool.startsWith('MCP: cockpit:') && /\bstart_process\b/.test(tool))), asked.join(' | '))
check('read-only cockpit tools never asked', !asked.some((t) => READ_ONLY.some((r) => t.includes(r))))

const { events } = await getJson<{ events: StoredEvent[] }>(page, `/api/threads/${threadId}/events`)
const tools = events.flatMap(({ event }) => (event.kind === 'tool_use' && event.name ? [event.name] : []))
check('agent started the dev server through Cockpit, unprompted', tools.includes('mcp__cockpit__start_process'), tools.join(', '))
// The log reaches the agent either through read_process_output or through start_process
// with wait_seconds, which returns the first lines. Either counts, if what came back is the
// server's own output.
const logTools = new Set(events.flatMap(({ event }) => event.kind === 'tool_use' && event.id &&
  (event.name === 'mcp__cockpit__read_process_output' || event.name === 'mcp__cockpit__start_process') ? [event.id] : []))
const sawLog = events.some(({ event }) => event.kind === 'tool_result' && logTools.has(event.toolUseId ?? '') &&
  JSON.stringify(event.content).includes('sprout dev server ready'))
check('agent read its dev-server log', sawLog, tools.includes('mcp__cockpit__read_process_output') ? 'read_process_output' : 'start_process output')
check('agent opened the preview itself', tools.includes('mcp__cockpit__open_preview'))

const processes = await getJson<ProcessInfo[]>(page, '/api/processes')
const dev = processes.find((p) => p.projectPath === project && p.status === 'running' && p.url)
check('dev server is running with its URL detected', Boolean(dev), JSON.stringify(processes.map((p) => [p.name, p.status, p.url])))
const devUrl = dev?.url ?? ''
// Since phase 7, open_preview shows the app in Cockpit's own preview pane (Browser ↗ still opens
// the external browser); either counts, at the dev server's port.
const portOf = (url: string): string => { try { return new URL(url).port } catch { return '' } }
const paneUrl = await page.locator('.preview-pane .preview-address code').textContent({ timeout: 10_000 }).catch(() => '') ?? ''
check('the preview opened at that URL', devUrl !== '' && [paneUrl, ...(await openedUrls())].some((url) => portOf(url) === portOf(devUrl)), `pane ${paneUrl}; external ${(await openedUrls()).join(', ')}; dev ${devUrl}`)
const served = devUrl ? await fetch(devUrl).then((r) => r.text()).catch(() => '') : ''
check('the site is actually served', served.includes('Sprout is growing'))
const ppid = dev?.pid ? execFileSync('ps', ['-o', 'ppid=', '-p', String(dev.pid)], { encoding: 'utf8' }).trim() : ''
check('the dev server is a child of the app', ppid === String(appPid), `ppid ${ppid}, app ${appPid}`)
check('tool calls read as plain activity lines', (await page.getByText('Opening the preview').count()) > 0)

// The header chip, and its list.
const chip = page.locator('.process-chip')
const port = devUrl ? new URL(devUrl).port : '?'
await chip.waitFor({ timeout: 10_000 })
check('header chip shows the running dev server', ((await chip.textContent()) ?? '').includes(`1 process· :${port}`), (await chip.textContent()) ?? '')
await page.screenshot({ path: join(PROOF_DIR, 'phase-4-thread.png') })
await chip.click()
const menu = page.getByRole('dialog', { name: 'Processes' })
check('process list shows the URL', (await menu.getByRole('link', { name: devUrl }).count()) === 1)
await page.screenshot({ path: join(PROOF_DIR, 'phase-4-processes.png') })

// Stop from the UI: the chip goes away and the port closes.
const firstPgid = dev?.pid ?? 0
await menu.getByRole('button', { name: /^Stop / }).click()
await waitUntil(page, 'the process to exit', async () =>
  (await getJson<ProcessInfo[]>(page, '/api/processes')).find((p) => p.id === dev?.id && p.status === 'exited'),
)
await page.keyboard.press('Escape')
await chip.waitFor({ state: 'detached', timeout: 10_000 })
const refused = await fetch(devUrl).then(() => false).catch(() => true)
check('Stop in the list stopped the whole dev server', refused && groupMembers(firstPgid).length === 0)

// Restart it, then quit the app with it running.
await messageBox(page).fill('Start the dev server again, please.')
await messageBox(page).press('Enter')
await approveUntilDone(page, threadId)
const again = await waitUntil(page, 'the restarted server', async () =>
  (await getJson<ProcessInfo[]>(page, '/api/processes')).find((p) => p.projectPath === project && p.status === 'running' && p.url),
)
const members = groupMembers(again.pid ?? 0)
check('agent restarted the dev server', members.length > 0, `group ${again.pid}: ${members.join(',')}`)

await app.close()
const survivors = members.filter(alive)
check('quitting the app left none of the dev server running', survivors.length === 0, survivors.join(','))

finish('PHASE 4')
