import assert from 'node:assert/strict'

/** Flags show native correction behavior; they are not stable cycle identities. */
export function assessCodexStopRecords(records: unknown, sessionId: string, turnId: string): unknown[] {
  assert.ok(Array.isArray(records) && records.length === 4, 'Expected both hooks before and after correction')
  const slots = new Set<string>()
  return records.map((row: any) => {
    assert.ok(row && ['a', 'b'].includes(row.label))
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0)
    assert.equal(row.input?.hook_event_name, 'Stop')
    assert.equal(row.input.session_id, sessionId)
    assert.equal(row.input.turn_id, turnId)
    assert.equal(typeof row.input.stop_hook_active, 'boolean')
    const slot = `${row.label}:${row.input.stop_hook_active}`
    assert.equal(slots.has(slot), false, 'Duplicate hook/correction observation')
    slots.add(slot)
    return { label: row.label, inputFields: Object.keys(row.input).sort(), sessionBound: true,
      turnBound: true, stopHookActive: row.input.stop_hook_active }
  })
}

/** Native run.id is opaque and can contain private paths; expose only reuse counts. */
export function assessCodexHookEvents(notifications: any[], sessionId: string, turnId: string): Record<string, unknown> {
  const events = notifications.filter((event) => ['hook/started', 'hook/completed'].includes(event.method))
  assert.equal(events.length, 8)
  const starts = new Map<string, number>(), completions = new Map<string, number>()
  const statuses: string[] = []
  for (const event of events) {
    assert.equal(event.params.threadId, sessionId)
    assert.equal(event.params.turnId, turnId)
    const run = event.params.run
    assert.equal(run.eventName, 'stop')
    assert.ok(typeof run.id === 'string' && run.id.length > 0)
    const counts = event.method === 'hook/started' ? starts : completions
    counts.set(run.id, (counts.get(run.id) ?? 0) + 1)
    if (event.method === 'hook/completed') {
      assert.ok(['completed', 'blocked'].includes(run.status))
      statuses.push(run.status)
    }
  }
  assert.deepEqual([...starts].sort(), [...completions].sort())
  return { nativeHookEvents: events.length, distinctRunIds: starts.size,
    runIdOccurrences: [...starts.values()].sort(), completionStatuses: statuses,
    sessionBound: true, turnBound: true, runIdsAreCycleIds: false }
}
