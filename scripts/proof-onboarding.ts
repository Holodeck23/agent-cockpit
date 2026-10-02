// Real-provider recovery gate. Usage: COCKPIT_ONBOARDING_OUT=/durable/evidence npm run proof:onboarding -- --live [--runs=3]
// Existing agent login is required. Creates a real prior ${provider} conversation, then times fresh Cockpit state.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchClaude } from '../server/agents/claude/launch.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'
import type { ThreadDetail } from '../web/src/api.ts'
import { SAMPLE_SERVER } from '../server/onboarding/sample.ts'
import { launchPackagedApp, ROOT } from './lib/launch-app.ts'

if (!process.argv.includes('--live')) throw new Error('This proof uses a real provider. Pass --live explicitly.')
if (!process.env.COCKPIT_ONBOARDING_OUT) throw new Error('Set COCKPIT_ONBOARDING_OUT to the durable evidence folder.')
const output = resolve(process.env.COCKPIT_ONBOARDING_OUT)
const provider = process.argv.includes('--agent=claude') ? 'claude' : 'codex'
const runs = Number(process.argv.find((v) => v.startsWith('--runs='))?.split('=')[1] ?? 1)
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 5, 'Use one to five measured runs')
mkdirSync(output, { recursive: true })
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const appPath = process.env.COCKPIT_APP ?? join(ROOT, 'release/mac-arm64/Cockpit.app')
const summaries: Array<Record<string, unknown>> = []

async function seed(project: string, evidence: string): Promise<string> {
  const events: NormalizedEvent[] = []
  let agent: AgentSession | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Prior-session setup exceeded 120 seconds')), 120_000)
      const onEvent = (event: NormalizedEvent) => {
        events.push(event)
        if (event.kind === 'result') { clearTimeout(timeout); event.ok ? resolve() : reject(new Error(event.text ?? 'Prior-session setup failed')) }
        if (event.kind === 'error') { clearTimeout(timeout); reject(new Error(event.message)) }
      }
      agent = provider === 'claude' ? launchClaude({ cwd: project, sessionId: randomUUID(), permissionMode: 'plan', useHooks: false }, onEvent) : launchCodex({ cwd: project, permissionMode: 'plan' }, onEvent)
      agent.send('We are working on the local launch-counter app in this folder. Next time, verify its existing counter in the preview and suggest a small improvement. For now reply only: Ready to resume the launch-counter app. Do not run tools or change files.')
    })
  } finally {
    await agent?.close()
    writeFileSync(join(evidence, 'seed-events.json'), JSON.stringify(events, null, 2))
  }
  const session = events.find((e) => e.kind === 'session')
  assert.ok(session?.kind === 'session', 'Prior real session must have a native id')
  return session.sessionId
}

for (let run = 1; run <= runs; run++) {
  const evidence = join(output, `run-${run}`)
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'cockpit-onboarding-live-'))
  const project = join(root, 'launch-counter')
  mkdirSync(project)
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(join(appPath, 'Contents/MacOS/Cockpit'))} server.cjs`
  const files = { 'server.cjs': SAMPLE_SERVER, 'README.md': `# Launch-counter app\n\nA dependency-free local web app with a working counter button.\n\nStart it with this exact command (the installed Cockpit runtime):\n\n\`\`\`sh\n${command}\n\`\`\`\n\nThe command prints its ephemeral local URL. There are no dependencies to install. In Cockpit use start_process for this command, read_process_output, open_preview and inspect_preview. Leave files unchanged during recovery.\n` }
  for (const [name, content] of Object.entries(files)) { writeFileSync(join(project, name), content); writeFileSync(join(evidence, name), content) }
  execFileSync('git', ['init', '-b', 'feature/counter', project])
  console.log(`Run ${run}: preparing a real prior ${provider} conversation (outside the activation stopwatch).`)
  const nativeId = await seed(project, evidence)
  const start = Date.now()
  const marks: Record<string, number> = {}
  const mark = (stage: string) => { if (marks[stage] === undefined) marks[stage] = Date.now() - start }
  const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'fresh-state') })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  let detail: ThreadDetail | undefined
  let approvals = 0, readApprovals = 0
  try {
    await page.getByRole('button', { name: 'Open a project', exact: true }).waitFor()
    mark('directorShown')
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
    await page.getByRole('button', { name: 'Open a project', exact: true }).click()
    mark('projectSelected')
    const card = page.getByRole('region', { name: 'Recent work' })
    await card.getByRole('button', { name: 'Resume and show me the app' }).waitFor()
    mark('recoveryOffered')
    const choices = card.getByLabel('Recent conversation')
    if (await choices.count()) await choices.selectOption(`${provider}:${nativeId}`)
    await card.getByLabel('Recovery agent').selectOption(provider)
    await page.screenshot({ path: join(evidence, 'recovery.png') })
    await card.getByRole('button', { name: 'Resume and show me the app' }).click()
    mark('resumeStarted')
    const approved = new Set<string>()
    while (Date.now() - start < 180_000) {
      detail = await page.evaluate(async () => {
        const threads = (await (await fetch('/api/threads')).json()).data
        if (!threads.length) return undefined
        return (await (await fetch(`/api/threads/${threads[0].meta.id}/events`)).json()).data
      }) as ThreadDetail | undefined
      if (!detail) { await page.waitForTimeout(250); continue }
      const events = detail.events.map((e) => e.event)
      const boundary = events.findLastIndex((e) => e.kind === 'user_text')
      const turn = events.slice(boundary + 1)
      for (const event of turn) {
        if (event.kind !== 'approval_request' || approved.has(event.requestId)) continue
        // One approval for the documented startup command only. Never auto-approve an arbitrary shell action.
        const input = JSON.stringify(event.input)
        const startup = /start_process/.test(input + event.toolName) && /server\.cjs/.test(input)
        const commandInput = (event.input as { command?: string }).command ?? ''
        const normalized = commandInput.replaceAll(realpathSync(project), 'PROJECT').replaceAll(project, 'PROJECT')
        const reads = ['pwd', 'ls', 'ls -la', 'ls -la PROJECT', 'git status --short --branch', 'git -C PROJECT status --short --branch']
        const safeRead = event.toolName === 'Bash' && normalized.split(/;|&&/).every((part) => reads.includes(part.trim()))
        assert.ok(startup || safeRead, `Unexpected approval: ${event.toolName} ${input}`)
        if (startup) { assert.equal(approvals, 0, 'At most one startup approval'); approvals++ }
        else { readApprovals++; assert.ok(readApprovals <= 4, 'Too many orientation approvals') }
        approved.add(event.requestId)
        await page.screenshot({ path: join(evidence, 'approval.png') })
        await page.locator('.approval.open').getByRole('button', { name: 'Allow', exact: true }).click()
        mark(startup ? 'startupApproved' : 'readApproved')
      }
      const opened = turn.find((e) => e.kind === 'tool_use' && e.name === 'mcp__cockpit__open_preview')
      if (opened?.kind === 'tool_use' && turn.some((e) => e.kind === 'tool_result' && e.toolUseId === opened.id && !e.isError)) mark('previewOpened')
      const inspected = turn.find((e) => e.kind === 'tool_use' && e.name === 'mcp__cockpit__inspect_preview')
      if (inspected?.kind === 'tool_use' && turn.some((e) => e.kind === 'tool_result' && e.toolUseId === inspected.id && !e.isError && /Screenshot of .*1280.800/.test(e.content))) mark('previewInspected')
      if (turn.some((e) => e.kind === 'assistant_text') && turn.some((e) => e.kind === 'result' && e.ok)) mark('conclusionProduced')
      const failure = turn.find((e) => e.kind === 'error' || (e.kind === 'result' && !e.ok))
      assert.ok(!failure, `Agent failed: ${JSON.stringify(failure)}`)
      if (marks.previewInspected !== undefined && marks.conclusionProduced !== undefined) break
      if (turn.some((e) => e.kind === 'result')) throw new Error('The agent ended without an inspected preview')
      await page.waitForTimeout(500)
    }
    assert.ok(detail && marks.previewInspected !== undefined && marks.conclusionProduced !== undefined, 'Inspected preview and conclusion within three minutes')
    assert.equal(detail.meta.sessionId, nativeId, 'Recovery retains the real native session')
    const frame = page.frameLocator('.preview-pane iframe')
    await frame.getByRole('heading', { name: 'Your first flight.' }).waitFor()
    await frame.getByRole('button', { name: 'Count a launch' }).click()
    await frame.getByText('1 launch', { exact: true }).waitFor()
    mark('secondActionTaken')
    for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(project, name), 'utf8'), content, `${name} unchanged`)
    await page.screenshot({ path: join(evidence, 'inspected-preview.png') })
    const seconds = Math.max(marks.previewInspected!, marks.conclusionProduced!) / 1000
    const summary = { run, provider, model: 'CLI default', nativeId, seconds, approvals, readApprovals, marks, passed: true,
      setup: 'Fresh Cockpit state; existing authenticated CLI; generated project and real prior conversation; scripted folder selection and approval.' }
    summaries.push(summary)
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(summary, null, 2))
    console.log(`PASS run ${run}: useful inspected result in ${seconds.toFixed(1)} seconds; ${approvals} startup approval, ${readApprovals} read approvals; interactive second action passed.`)
  } catch (error) {
    const summary = { run, passed: false, approvals, readApprovals, marks, failure: String(error) }
    summaries.push(summary)
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(summary, null, 2))
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    if (detail) writeFileSync(join(evidence, 'conversation.json'), JSON.stringify(detail, null, 2))
    writeFileSync(join(output, 'runs.json'), JSON.stringify(summaries, null, 2))
    await app.close()
  }
}
const times = summaries.map((s) => s.seconds as number).sort((a, b) => a - b)
const median = times.length % 2 ? times[Math.floor(times.length / 2)]! : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2
const p90 = times[Math.ceil(times.length * .9) - 1]!
const result = { runs, medianSeconds: median, p90Seconds: p90, reachedValueWithin180Percent: 100 * times.filter((t) => t < 180).length / runs,
  secondActionPercent: 100, note: 'Small machine-operated sample, not population timing or second-person installation acceptance.' }
writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2))
assert.ok(median < 120 && p90 < 180, 'Median <120s and p90 <180s in this sample')
console.log(`PROOF ONBOARDING PASS ${JSON.stringify(result)}`)
