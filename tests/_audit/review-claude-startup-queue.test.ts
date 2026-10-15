import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchClaude } from '../../server/agents/claude/launch.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import { createThreadManager, type ThreadManager } from '../../server/threads/manager.ts'
import { isBusy } from '../../server/threads/status.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// Review of claude-1: messages sent while Claude starts were delivered but reported as not queued
// (queues() was false until the --help probe resolved). The thread manager then recorded the second
// one as a fresh turn: when message 1 finished, the conversation showed idle although Claude was about
// to work on message 2. A message sent mid-turn during startup is a queued message like any other.

const HELP = readFileSync('scripts/fixtures/claude-help.txt', 'utf8')
const HELP_WITHOUT_REPLAY = HELP.split('\n').filter((line) => !line.includes('--replay-user-messages')).join('\n')
const RESULT = (text: string): string => `{"type":"result","subtype":"success","is_error":false,"result":"${text}"}`

/** A stand-in Claude: `--help` takes a moment; message 1 is answered at once; the next ones wait for the `go` file. */
function fakeClaude(help: string, replays: boolean): { dir: string; executable: string; received: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-review-claude-'))
  const executable = join(dir, 'claude')
  const received = join(dir, 'stdin.log')
  writeFileSync(join(dir, 'help'), help)
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--help" ]; then sleep 0.3; cat "${join(dir, 'help')}"; exit 0; fi
printf '{"type":"system","subtype":"init","session_id":"review-claude"}\\n'
n=0
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      request_id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\\n' "$request_id"
      continue
      ;;
  esac
  n=$((n+1))
  printf '%s\\n' "$line" >> "${received}"
  uuid=$(printf '%s' "$line" | sed -n 's/.*"uuid":"\\([^"]*\\)".*/\\1/p')
  if [ $n -eq 1 ]; then
    if [ "${replays ? 'yes' : 'no'}" = "yes" ] && [ -n "$uuid" ]; then
      printf '{"type":"user","isReplay":true,"uuid":"%s","message":{"role":"user","content":"one"}}\\n' "$uuid"
    fi
    printf '%s\\n' '${RESULT('one')}'
    continue
  fi
  while [ ! -f "${join(dir, 'go')}" ]; do sleep 0.05; done
  if [ "${replays ? 'yes' : 'no'}" = "yes" ] && [ -n "$uuid" ]; then
    printf '{"type":"user","isReplay":true,"uuid":"%s","message":{"role":"user","content":"two"}}\\n' "$uuid"
  fi
  printf '%s\\n' '${RESULT('two')}'
done
`)
  chmodSync(executable, 0o755)
  return { dir, executable, received }
}

const managers: ThreadManager[] = []
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown() })

function harness(executable: string) {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-review-claude-state-')))
  const project = mkdtempSync(join(tmpdir(), 'cockpit-review-claude-project-'))
  const manager = createThreadManager(store, {
    launchers: { claude: (request, onEvent) => launchClaude({ cwd: request.cwd, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }, onEvent, { executable }) },
  })
  managers.push(manager)
  const events = (id: string) => store.events(id).map((e) => e.event)
  const status = (id: string) => manager.summaries().find((s) => s.meta.id === id)!.status
  const thread = manager.create({ projectPath: project, settings: threadSettingsSchema.parse({ agent: 'claude' }), text: 'one' })
  return { manager, store, thread, events, status }
}

describe('review: a message sent while Claude is still starting is queued like any other', () => {
  it('the session reports it queues from the start, and a message can be taken back before it was written', async () => {
    const { executable, received } = fakeClaude(HELP, true)
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-review-claude-cwd-'))
    const events: NormalizedEvent[] = []
    const session = launchClaude({ cwd }, (event) => events.push(event), { executable })
    try {
      expect(session.queues?.()).toBe(true)
      session.send('keep me')
      session.send('take me back', 'q1')
      expect(await session.cancelQueued!('q1')).toBe(true)
      expect(await session.cancelQueued!('q1')).toBe(false)
      await expect.poll(() => { try { return readFileSync(received, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }, { timeout: 5000 }).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(readFileSync(received, 'utf8')).not.toContain('take me back')
      expect(session.queues?.()).toBe(true)
    } finally { await session.close() }
  }, 15000)

  it('the second message is recorded as waiting, and the conversation stays busy until Claude takes it', async () => {
    const claude = fakeClaude(HELP, true)
    const { manager, thread, events, status } = harness(claude.executable)
    // The probe is still running: message 1 is held, and message 2 is sent behind it.
    manager.send(thread.id, 'two')
    const second = events(thread.id).filter((e) => e.kind === 'user_text')[1]
    expect(second).toMatchObject({ kind: 'user_text', text: 'two', queuedId: expect.any(String) })

    // Message 1 ends; message 2 is still waiting for Claude, so the conversation is not idle.
    await expect.poll(() => events(thread.id).some((e) => e.kind === 'result'), { timeout: 5000 }).toBe(true)
    expect(isBusy(status(thread.id))).toBe(true)

    // Claude takes message 2 and finishes it.
    writeFileSync(join(claude.dir, 'go'), '')
    await expect.poll(() => events(thread.id).filter((e) => e.kind === 'result').length, { timeout: 5000 }).toBe(2)
    expect(isBusy(status(thread.id))).toBe(false)
  }, 20000)

  it('when Claude cannot say when it takes a message, the one that waited is not left waiting forever', async () => {
    const claude = fakeClaude(HELP_WITHOUT_REPLAY, false)
    const { manager, thread, events, status } = harness(claude.executable)
    manager.send(thread.id, 'two')
    await expect.poll(() => events(thread.id).some((e) => e.kind === 'result'), { timeout: 5000 }).toBe(true)
    writeFileSync(join(claude.dir, 'go'), '')
    await expect.poll(() => events(thread.id).filter((e) => e.kind === 'result').length, { timeout: 5000 }).toBe(2)
    await expect.poll(() => isBusy(status(thread.id)), { timeout: 5000 }).toBe(false)
  }, 20000)
})
