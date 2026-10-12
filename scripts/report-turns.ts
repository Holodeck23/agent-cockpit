// How agents' turns end, per agent, across every conversation in Cockpit's state folder. Read-only.
//
//   npm run report:turns              a table, one row per agent
//   npm run report:turns -- --json    one JSON row per turn, imported turns included and marked
//
// Reads $COCKPIT_HOME (default ~/.agent-cockpit) threads/*/events.jsonl and meta.json. Imported
// turns (whose ends the importer guessed) are left out of the table. Outcomes: server/threads/turn-outcomes.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '../server/agents/types.ts'
import { defaultRoot } from '../server/threads/store.ts'
import { turnOutcomes, type TurnOutcome, type TurnRow } from '../server/threads/turn-outcomes.ts'
import type { StoredEvent } from '../server/threads/types.ts'

const COLUMNS: readonly TurnOutcome[] = ['question', 'blocked', 'silent_after_refusal', 'recovered', 'silent', 'stopped', 'failed']
const AGENTS = new Set<AgentId>(['claude', 'codex', 'antigravity', 'opencode'])

const args = process.argv.slice(2)
const unknown = args.filter((arg) => arg !== '--json')
if (unknown.length) {
  console.error(`report:turns: unknown option ${unknown.join(' ')}\nusage: npm run report:turns [-- --json]`)
  process.exit(2)
}

/** Complete lines only; a line that does not parse (a write in progress) is skipped and counted. */
function readEvents(file: string): { events: StoredEvent[]; skipped: number } {
  const events: StoredEvent[] = []
  let skipped = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Partial<StoredEvent>
      if (typeof row.ts === 'string' && typeof row.event === 'object' && row.event !== null) events.push(row as StoredEvent)
      else skipped += 1
    } catch { skipped += 1 }
  }
  return { events, skipped }
}

function agentOf(metaFile: string): AgentId | undefined {
  try {
    const agent = (JSON.parse(readFileSync(metaFile, 'utf8')) as { settings?: { agent?: unknown } }).settings?.agent ?? 'claude'
    return AGENTS.has(agent as AgentId) ? agent as AgentId : undefined
  } catch { return undefined }
}

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

const root = defaultRoot()
const threadsDir = join(root, 'threads')
if (!existsSync(threadsDir)) {
  console.error(`report:turns: no conversations in ${root}`)
  process.exit(1)
}

const rows: (TurnRow & { thread: string })[] = []
let conversations = 0
let skippedLines = 0
let unreadable = 0
for (const id of readdirSync(threadsDir).sort()) {
  const eventsFile = join(threadsDir, id, 'events.jsonl')
  const agent = agentOf(join(threadsDir, id, 'meta.json'))
  if (!existsSync(eventsFile) || !agent) { unreadable += 1; continue }
  const { events, skipped } = readEvents(eventsFile)
  skippedLines += skipped
  conversations += 1
  for (const row of turnOutcomes(events, agent)) rows.push({ thread: id, ...row })
}

if (args.includes('--json')) {
  for (const row of rows) console.log(JSON.stringify(row))
  process.exit(0)
}

const live = rows.filter((row) => !row.imported)
const header = ['agent', 'turns', 'concluded %', ...COLUMNS, 'median tokensIn', 'median ms']
const table = [...new Set(live.map((row) => row.agent))].sort().map((agent) => {
  const mine = live.filter((row) => row.agent === agent)
  const count = (outcome: TurnOutcome): number => mine.filter((row) => row.outcome === outcome).length
  const tokens = median(mine.flatMap((row) => (row.tokensIn === undefined ? [] : [row.tokensIn])))
  const ms = median(mine.flatMap((row) => (row.durationMs === undefined ? [] : [row.durationMs])))
  return [agent, String(mine.length), `${Math.round((count('concluded') / mine.length) * 100)}`, ...COLUMNS.map((c) => String(count(c))),
    tokens === undefined ? '-' : String(tokens), ms === undefined ? '-' : String(ms)]
})
const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)))
const line = (cells: readonly string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
console.log(line(header))
for (const row of table) console.log(line(row))
console.log(`\n${conversations} conversations, ${live.length} live turns, ${rows.length - live.length} imported turns left out`
  + (skippedLines ? `, ${skippedLines} unreadable lines skipped` : '') + (unreadable ? `, ${unreadable} folders without events or a known agent` : ''))
