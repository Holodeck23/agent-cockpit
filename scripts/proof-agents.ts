// Checkpoint 2 gate (agent availability and usage), PACKAGED app: `npm run proof:agents`. No agent usage.
// Stand-ins found through COCKPIT_AGENT_PATH: a working `claude` and a broken `codex`. Usage
// reports are seeded into the store between picker openings, since the picker re-reads on open.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { AgentId, NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const { check, finish } = checker()
const agentPath = ['scripts/fixtures/limit-agent', 'scripts/fixtures/broken-codex'].map((dir) => join(ROOT, dir)).join(':')
const project = join(mkdtempSync(join(tmpdir(), 'cockpit-agents-proof-')), 'agents-project')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })

const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: agentPath })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Agents proof')
  const home = await app.evaluate(() => process.env.COCKPIT_HOME ?? '')
  const store = createThreadStore(home)
  const report = (agent: AgentId, event: NormalizedEvent): void => {
    const id = randomUUID()
    const now = new Date().toISOString()
    store.create({ id, title: `${agent} usage`, projectPath: project, settings: threadSettingsSchema.parse({ agent }),
      sessionId: randomUUID(), sessionStarted: true, completed: false, createdAt: now, updatedAt: now })
    store.append(id, event)
  }

  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  async function stateOf(agent: 'Claude Code' | 'Codex'): Promise<string> {
    if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Agent settings' }).click()
    await panel.getByRole('radio', { name: new RegExp(`^${agent}`) }).click()
    const group = panel.getByRole('group', { name: `${agent} status` })
    await group.waitFor()
    return ((await group.textContent()) ?? '').replace(/\s+/g, ' ').trim()
  }
  const reopen = async (): Promise<void> => {
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
  }

  const claudeFresh = await stateOf('Claude Code')
  check('an installed agent shows its version', claudeFresh.includes('Installed · 0.0.0 (Cockpit limit fixture)'), claudeFresh)
  check('with no report yet, usage reads as unknown, not available', claudeFresh.includes('No usage reported yet'), claudeFresh)
  const codexBroken = await stateOf('Codex')
  check('a CLI that fails its version check shows the problem', codexBroken.includes('codex --version failed'), codexBroken)
  check('the broken agent is marked in the agent switch', (await panel.getByRole('radio', { name: /^Codex/ }).textContent())?.includes('Unavailable') === true)
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-2-agent-problem.png') })
  await reopen()

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(1, 0, 0, 0)
  report('claude', { kind: 'usage', limitType: 'five_hour', status: 'allowed', resetsAt: tomorrow.getTime() / 1000, usedPercent: 40 })
  const percent = await stateOf('Claude Code')
  check('a reported percentage shows as a meter with its value', percent.includes('5-hour usage: 40% used') &&
    (await panel.getByRole('meter', { name: 'Claude Code usage' }).getAttribute('aria-valuenow')) === '40', percent)
  check('a reset on another day names the day', percent.includes('resets tomorrow'), percent)
  check('the report says when it was observed', /as of \d/.test(percent), percent)
  await page.screenshot({ path: join(PROOF_DIR, 'checkpoint-2-agent-usage.png') })
  await reopen()

  await new Promise((resolve) => setTimeout(resolve, 10))
  const earlier = Math.floor(Date.now() / 1000) - 3600
  report('claude', { kind: 'usage', limitType: 'five_hour', status: 'rejected', resetsAt: earlier })
  const limited = await stateOf('Claude Code')
  check('the newest report wins', limited.includes('Limit reached'), limited)
  check('a limit whose reset time has passed says so instead of implying it still holds', limited.includes('no newer report'), limited)
  check('no meter is drawn without a reported percentage', (await panel.getByRole('meter').count()) === 0)
  await reopen()
} finally {
  await app.close()
}
finish('AGENTS')
