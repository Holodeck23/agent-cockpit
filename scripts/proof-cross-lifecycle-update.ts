// CROSS-06 for proof:cross-lifecycle: a CLI update asked for while agents run in two workspaces of
// one conversation and a host check runs. The shared executable is not replaced until that work
// ends; new sessions wait; the update then runs without any bypass; history survives it.
//
// The app gets its own HOME and a login shell without Homebrew (as proof:wave-10), with one `claude`
// that answers both ways: --version / auth / update go to the wave 10 stand-in (state in
// $HOME/.fcli), stream-json sessions go to the wave 12 stand-in (HOLD keeps a turn until Stop).
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject } from './lib/ui.ts'

type Check = (name: string, ok: boolean, detail?: string) => void

export async function crossSix(check: Check, root: string): Promise<void> {
  const home = join(root, 'home6'), state = join(root, 'state-6'), garden = join(root, 'garden6')
  const fix10 = join(ROOT, 'scripts/fixtures/wave10-cli')
  for (const dir of [garden, join(home, '.fcli'), join(home, '.local/bin'), join(home, '.local/share/claude/versions')]) mkdirSync(dir, { recursive: true })
  copyFileSync(join(ROOT, 'scripts/fixtures/claude-help.txt'), join(home, '.fcli/claude-help.txt'))
  writeFileSync(join(home, '.fcli/claude-signed-in'), '')
  const fcli = join(home, '.local/share/claude/fcli')
  copyFileSync(join(fix10, 'fcli'), fcli)
  const versioned = join(home, '.local/share/claude/versions/2.1.289')
  writeFileSync(versioned, `#!/bin/sh\ncase " $* " in *" --input-format "*) exec "${join(ROOT, 'scripts/fixtures/wave12-agent/claude')}" "$@" ;; esac\nexec /bin/bash "${fcli}" "$@"\n`)
  for (const file of [fcli, versioned]) chmodSync(file, 0o755)
  symlinkSync(versioned, join(home, '.local/bin/claude'))
  const ident = { GIT_AUTHOR_NAME: 'G', GIT_AUTHOR_EMAIL: 'g@example.invalid', GIT_COMMITTER_NAME: 'G', GIT_COMMITTER_EMAIL: 'g@example.invalid' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: garden, env: { ...process.env, ...ident } })
  git('init', '-q', '-b', 'main'); writeFileSync(join(garden, 'notes.txt'), 'main\n'); git('add', '.'); git('commit', '-q', '-m', 'first')
  const version = (): string => (existsSync(join(home, '.fcli/claude-version')) ? readFileSync(join(home, '.fcli/claude-version'), 'utf8').trim() : '2.1.289')

  const until = async <T>(label: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T | undefined> => {
    const end = Date.now() + ms
    while (Date.now() < end) { const v = await read().catch(() => undefined); if (v) return v; await new Promise((r) => setTimeout(r, 150)) }
    console.log(`  (timed out waiting for ${label})`)
    return undefined
  }
  const call = <T>(page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
    const res = await fetch(p as string, { method: m as string, headers: { 'content-type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
    const json = await res.json().catch(() => ({})) as { data?: unknown; error?: string }
    return { status: res.status, data: json.data as T | undefined, error: json.error }
  }, [method, path, body] as const)
  const get = async <T>(page: Page, path: string): Promise<T> => (await call<T>(page, 'GET', path)).data as T
  type Detail = { status: string; events: Array<{ ts: string; event: { kind: string; text?: string; message?: string } }>; runs?: Array<{ workspaceId: string; working: boolean }> }
  const workingIn = async (page: Page, id: string) => ((await get<Detail>(page, `/api/threads/${id}/events`)).runs ?? []).filter((r) => r.working).map((r) => r.workspaceId)
  const sleepers = (pattern: string): number => { try { return execFileSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).length } catch { return 0 } }
  const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Agent settings' })
  const lifecycle = (page: Page): Locator => picker(page).getByRole('group', { name: 'Install and updates' })
  const text = async (l: Locator) => (await l.innerText().catch(() => '')).replace(/\s+/g, ' ')

  let app: ElectronApplication | undefined
  try {
    app = await launchPackagedApp({ HOME: home, SHELL: join(fix10, 'login-shell'), COCKPIT_HOME: state }, ['--use-mock-keychain'])
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await openProject(page, garden, 'Garden')
    const pid = (await get<Array<{ path: string; projectId: string }>>(page, '/api/projects')).find((p) => p.path === garden)!.projectId
    const rose = (await call<{ workspace: { id: string } }>(page, 'POST', `/api/projects/${pid}/workspaces`, { name: 'Rose bed' })).data!.workspace
    const primary = (await get<{ workspaces: Array<{ id: string; kind: string }> }>(page, `/api/projects/${pid}/workspaces`)).workspaces.find((w) => w.kind === 'primary')!

    console.log('  · CROSS-06 a check runs, and one conversation works in two workspaces')
    const done = (await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: garden, workspaceId: primary.id, text: 'a quick look' })).data!.id
    await until('quick look done', async () => (await get<Detail>(page, `/api/threads/${done}/events`)).events.some((e) => e.event.kind === 'result'))
    await page.reload()
    await page.getByRole('navigation', { name: 'Conversations' }).getByText('a quick look').first().click()
    const card = page.locator('.result-card').last()
    await card.waitFor()
    await card.locator('summary').click()
    await card.getByLabel('Exact command').fill('sleep 113')
    await card.getByRole('button', { name: 'Run exactly this check' }).click()
    await until('check running', async () => sleepers('sleep 113') > 0)
    const p = (await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: garden, workspaceId: primary.id, text: 'HOLD main work' })).data!.id
    await until('main working', async () => (await workingIn(page, p)).length === 1)
    await call(page, 'POST', `/api/threads/${p}/messages`, { text: 'HOLD rose work', workspaceId: rose.id })
    await until('both working', async () => (await workingIn(page, p)).length === 2)
    const historyBefore = (await get<Detail>(page, `/api/threads/${p}/events`)).events.map((e) => `${e.ts} ${e.event.kind}`)

    console.log('  · CROSS-06 update Claude Code while all of that runs')
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await picker(page).getByRole('radio', { name: /^Claude Code/ }).click()
    await until('lifecycle', async () => (await lifecycle(page).getByRole('button', { name: 'Update…', exact: true }).count()) === 1)
    await lifecycle(page).getByRole('button', { name: 'Update…', exact: true }).click()
    await lifecycle(page).locator('.lifecycle-confirm').getByRole('button', { name: 'Update', exact: true }).click()
    const waiting = await until('waiting', async () => /Waiting for 2 running Claude Code sessions to finish/.test(await text(lifecycle(page))) && await text(lifecycle(page)))
    check('CROSS-06 the update waits for both running Claude Code sessions (one conversation, two workspaces), and says so', Boolean(waiting), waiting || await text(lifecycle(page)))
    await page.screenshot({ path: join(PROOF_DIR, 'cross-life-06-waiting.png') })
    await page.keyboard.press('Escape')
    await new Promise((r) => setTimeout(r, 1500))
    check('CROSS-06 the shared executable is not replaced while they work', version() === '2.1.289', version())
    const agentsBefore = sleepers('wave12-agent/claude')
    const fresh = await call<{ id: string }>(page, 'POST', '/api/threads', { projectPath: garden, workspaceId: primary.id, text: 'a new conversation now' })
    await new Promise((r) => setTimeout(r, 1500))
    const freshEvents = fresh.data ? (await get<Detail>(page, `/api/threads/${fresh.data.id}/events`)).events : []
    check('CROSS-06 a new session waits for the update instead of starting on the old executable',
      sleepers('wave12-agent/claude') === agentsBefore && JSON.stringify(freshEvents).includes('waiting to update'), JSON.stringify(freshEvents.map((e) => e.event.message ?? e.event.text ?? e.event.kind)).slice(0, 300))

    console.log('  · CROSS-06 the work ends the ordinary way: Stop Rose bed, then the main checkout')
    await call(page, 'POST', `/api/threads/${p}/interrupt`, { workspaceId: rose.id })
    await until('rose stopped', async () => (await workingIn(page, p)).length === 1)
    await new Promise((r) => setTimeout(r, 1000))
    check('CROSS-06 one workspace still working: still no update', version() === '2.1.289', version())
    await call(page, 'POST', `/api/threads/${p}/interrupt`, {})
    const updated = await until('updated', async () => version() === '2.1.292', 30_000)
    check('CROSS-06 once both are idle the update runs by itself, no bypass', Boolean(updated), version())
    check('CROSS-06 the running check was not touched by it', sleepers('sleep 113') > 0)
    const historyAfter = (await get<Detail>(page, `/api/threads/${p}/events`)).events.map((e) => `${e.ts} ${e.event.kind}`)
    check('CROSS-06 the conversation\'s history survives the update, every event in order', historyBefore.every((line, i) => historyAfter[i] === line), `${historyBefore.length} → ${historyAfter.length}`)
    await call(page, 'POST', `/api/threads/${p}/messages`, { text: 'after the update', workspaceId: primary.id })
    const replied = await until('reply after update', async () => (await get<Detail>(page, `/api/threads/${p}/events`)).events.some((e) => e.event.kind === 'assistant_text' && e.event.text?.includes('turn=')
      && e.ts > historyBefore.at(-1)!.split(' ')[0]!), 20_000)
    check('CROSS-06 and it carries on after it', Boolean(replied))
    await card.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => undefined)
  } catch (error) {
    check('CROSS-06 ran to the end', false, error instanceof Error ? error.message : String(error))
  } finally {
    await app?.close().catch(() => undefined)
  }
}
