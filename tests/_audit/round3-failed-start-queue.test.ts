import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchClaude } from '../../server/agents/claude/launch.ts'
import { createThreadManager, type ThreadManager } from '../../server/threads/manager.ts'
import { isBusy } from '../../server/threads/status.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'
import { buildTranscript } from '../../web/src/transcript.ts'

// Round 3, problem 1: since a message sent while Claude starts counts as queued, a start that FAILS
// (the --help probe errors, the CLI is missing) left that message in the manager's waiting set. The
// failed start's result then set the conversation busy again for it, and the exit that followed recorded
// a second failed result: two failure cards (each with Retry) for one failed start. The queued message
// can never be taken; it has to show as not delivered, once, not vanish into a normal-looking message.

/** A stand-in `claude` whose --help fails, so the start fails after the first two messages are in. */
function brokenClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-round3-claude-'))
  const executable = join(dir, 'claude')
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--help" ]; then sleep 0.2; echo 'claude: cannot start' >&2; exit 3; fi\nexit 0\n`)
  chmodSync(executable, 0o755)
  return executable
}

const managers: ThreadManager[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown() })

function harness() {
  const executable = brokenClaude()
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-round3-state-')))
  const project = mkdtempSync(join(tmpdir(), 'cockpit-round3-project-'))
  const manager = createThreadManager(store, {
    launchers: { claude: (request, onEvent) => launchClaude({ cwd: request.cwd, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }, onEvent, { executable }) },
  })
  managers.push(manager)
  const thread = manager.create({ projectPath: project, settings: threadSettingsSchema.parse({ agent: 'claude' }), text: 'one' })
  return { manager, store, thread }
}

describe('round 3: a failed Claude start with a message queued during startup', () => {
  it('keeps the first message recoverable when provider initialize never answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-readiness-stall-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-readiness-project-'))
    const executable = join(dir, 'claude')
    writeFileSync(join(dir, 'help'), readFileSync('tests/fixtures/claude-2.1.291-help.txt'))
    writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--help" ]; then cat "$(dirname "$0")/help"; exit 0; fi\nwhile IFS= read -r line; do printf "%s\\n" "$line" >> requests; done\n')
    chmodSync(executable, 0o755)
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-readiness-state-')))
    const manager = createThreadManager(store, {
      launchers: { claude: (request, onEvent) => launchClaude({ cwd: request.cwd }, onEvent, { executable, initializeTimeoutMs: 100 }) },
    })
    managers.push(manager)
    const thread = manager.create({ projectPath: project, settings: threadSettingsSchema.parse({ agent: 'claude' }), text: 'must remain recoverable' })
    const first = store.events(thread.id).find((entry) => entry.event.kind === 'user_text')?.event
    expect(first).toMatchObject({ queuedId: expect.any(String) })
    await expect.poll(() => store.events(thread.id).some((entry) => entry.event.kind === 'exit'), { timeout: 5000 }).toBe(true)
    expect(buildTranscript(store.events(thread.id), 'claude').find((item) => item.type === 'message'))
      .toMatchObject({ undelivered: true, restoreText: 'must remain recoverable' })
    expect(readFileSync(join(project, 'requests'), 'utf8')).not.toContain('must remain recoverable')
  })

  it('records one failure and shows the queued message as not delivered', async () => {
    const { manager, store, thread } = harness()
    manager.send(thread.id, 'two')
    const second = store.events(thread.id).map((e) => e.event).filter((e) => e.kind === 'user_text')[1]
    expect(second).toMatchObject({ text: 'two', queuedId: expect.any(String) })

    await expect.poll(() => store.events(thread.id).some((e) => e.event.kind === 'exit'), { timeout: 5000 }).toBe(true)
    const events = store.events(thread.id)
    const kinds = events.map((e) => e.event.kind)

    // One failed start is one failed result and one exit.
    expect(events.filter((e) => e.event.kind === 'result' && !e.event.ok)).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'exit')).toHaveLength(1)
    // The conversation is not left busy for a message that can no longer be taken.
    const summary = manager.summaries().find((s) => s.meta.id === thread.id)!
    expect(isBusy(summary.status)).toBe(false)

    // The transcript: one failure card, and neither input crossed the provider boundary.
    const items = buildTranscript(events, 'claude')
    expect(items.filter((item) => item.type === 'failure')).toHaveLength(1)
    const messages = items.filter((item) => item.type === 'message')
    expect(messages.map((item) => item.text)).toEqual(['one', 'two'])
    expect(messages[0]).toMatchObject({ undelivered: true, restoreText: 'one' })
    expect(messages[1]).toMatchObject({ undelivered: true })
    expect(messages[1]).not.toHaveProperty('queuedId')
  }, 20000)
})
