// Turn quality, LIVE: the real agents through Cockpit's server, without Cockpit's tools, in a temp
// state folder and a scratch project. Uses a little provider usage on each agent.
//   A  Antigravity, Manual (its own configured permissions): a step its policy refuses ends the turn
//      silently; Cockpit sends exactly one note; the reply runs no tools; the report counts it recovered.
//   B  Claude Code and Codex, one turn each: the turn ends with a message (the turn shape reached them).
// Usage: npm run build && npm run proof:turns-live [-- --only antigravity|claude|codex]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentId } from '../server/agents/types.ts'
import { startServer } from '../server/start.ts'
import { turnOutcomes } from '../server/threads/turn-outcomes.ts'
import type { StoredEvent } from '../server/threads/types.ts'
import { checker } from './lib/launch-app.ts'

const { check, finish } = checker()
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'cockpit-turns-live-'))
const project = join(root, 'scratch-notes')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# Scratch notes\n')
writeFileSync(join(project, 'todo.txt'), 'buy bread\n')
// No `mcp`: sessions run without Cockpit's tools, as Antigravity does in a project that has not opted in.
const running = await startServer({ port: 0, webDist: fileURLToPath(new URL('../dist', import.meta.url)), stateRoot: join(root, 'state') })
const api = async (path: string, body?: unknown): Promise<{ data?: { id: string } }> => {
  const res = await fetch(`${running.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json() as Promise<{ data?: { id: string } }>
}

/**
 * Waits until the conversation has been idle for a few seconds (a follow-up starts on the next tick).
 * Approval cards are denied, as a person who only wants the answer would: the turn must still end in a reply.
 */
async function settle(id: string, ms = 300_000): Promise<StoredEvent[]> {
  const end = Date.now() + ms
  let idleSince = 0
  while (Date.now() < end) {
    const status = running.manager.status(id)
    if (status === 'needs_input') {
      const events = running.store.events(id)
      const resolved = new Set(events.flatMap((e) => (e.event.kind === 'approval_resolved' ? [e.event.requestId] : [])))
      for (const e of events) {
        if (e.event.kind === 'approval_request' && !resolved.has(e.event.requestId)) await api(`/api/threads/${id}/approvals/${e.event.requestId}`, { behavior: 'deny' })
      }
    }
    if (status === 'working' || status === 'starting' || status === 'needs_input') idleSince = 0
    else if (!idleSince) idleSince = Date.now()
    else if (Date.now() - idleSince > 6_000) break
    await sleep(500)
  }
  return running.store.events(id)
}

const show = (events: readonly StoredEvent[]): string => events.map(({ event: e }) =>
  e.kind === 'user_text' ? `\n    ${e.fromCockpit ? 'COCKPIT' : 'YOU'}: ${e.text.slice(0, 160)}`
  : e.kind === 'assistant_text' ? `\n    AGENT: ${e.text.replace(/\s+/g, ' ').slice(0, 300)}`
  : e.kind === 'tool_use' ? `\n    tool ${e.name} ${JSON.stringify(e.input).slice(0, 100)}`
  : e.kind === 'tool_result' ? `\n    → ${e.isError ? 'ERROR ' : ''}${e.content.replace(/\s+/g, ' ').slice(0, 120)}`
  : e.kind === 'result' ? `\n    result ok=${e.ok}${e.text ? ` text=${JSON.stringify(e.text.slice(0, 60))}` : ''}${e.denied ? ` denied=${JSON.stringify(e.denied)}` : ''}`
  : e.kind === 'error' ? `\n    error ${e.message.slice(0, 200)}` : '').join('')

try {
  await api('/api/projects', { path: project, name: 'Scratch notes' })

  if (!only || only === 'antigravity') {
    const thread = await api('/api/threads', { projectPath: project, text: 'Run `find . -maxdepth 1 -type f` and tell me what it printed',
      settings: { agent: 'antigravity', permissionMode: 'manual', useHooks: false } })
    const events = await settle(thread.data!.id)
    console.log(`  A transcript:${show(events)}`)
    const notes = events.flatMap((e, i) => (e.event.kind === 'user_text' && e.event.fromCockpit ? [i] : []))
    const refused = events.some((e) => (e.event.kind === 'tool_result' && e.event.isError && /denied permission|has been denied/i.test(e.event.content))
      || (e.event.kind === 'result' && Boolean(e.event.denied?.length)))
    check('A: a step was refused by Antigravity\'s own policy', refused)
    check('A: Cockpit sent exactly one note', notes.length === 1, `${notes.length} note(s)`)
    const after = notes.length ? events.slice(notes[0]! + 1) : []
    check('A: the note\'s turn ran no tools', !after.some((e) => e.event.kind === 'tool_use'))
    const reply = after.find((e) => e.event.kind === 'assistant_text')
    const sentences = reply?.event.kind === 'assistant_text' ? reply.event.text.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 2).length : 0
    check('A: Antigravity replied after the note, briefly', Boolean(reply) && sentences <= 5, `${sentences} sentence(s)`)
    const rows = turnOutcomes(events, 'antigravity')
    check('A: the turn report counts it recovered', rows.length === 1 && rows[0]!.outcome === 'recovered', JSON.stringify(rows.map((r) => r.outcome)))
  }

  for (const agent of ['claude', 'codex'] as const satisfies readonly AgentId[]) {
    if (only && only !== agent) continue
    const thread = await api('/api/threads', { projectPath: project, text: 'In one sentence, what is this folder for? Look at its files first.',
      settings: { agent, permissionMode: 'manual', useHooks: false } })
    const events = await settle(thread.data!.id)
    console.log(`  B ${agent} transcript:${show(events)}`)
    const rows = turnOutcomes(events, agent)
    check(`B: ${agent} ends its turn with a final message`, rows.length === 1 && ['concluded', 'question', 'blocked'].includes(rows[0]!.outcome), JSON.stringify(rows.map((r) => r.outcome)))
  }
} finally {
  await running.close()
}
finish('turns live')
