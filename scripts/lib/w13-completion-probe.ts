import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Writes are permitted only after this invocation exclusively creates the directory. */
export class ProbeAttempt {
  private evidenceOwned = false
  private privateOwned = false
  constructor(readonly evidence: string, readonly privateDir: string) {}
  create(): void {
    mkdirSync(this.evidence, { mode: 0o700 })
    this.evidenceOwned = true
    mkdirSync(this.privateDir, { mode: 0o700 })
    this.privateOwned = true
  }
  writePrivate(name: string, content: string | Buffer): void {
    if (this.privateOwned) writeFileSync(join(this.privateDir, name), content, { flag: 'wx', mode: 0o600 })
  }
  writeReceipt(receipt: unknown): void {
    if (this.evidenceOwned) writeFileSync(join(this.evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
}

/** Count bytes before readline can retain an arbitrarily long, unterminated line. */
export class ProbeOutput {
  private chunks: Buffer[] = []
  bytes = 0
  overflow = false
  constructor(readonly limit = 2_000_000) {}
  append(channel: 'stdout' | 'stderr', chunk: Buffer): void {
    this.bytes += chunk.length
    if (this.bytes > this.limit) { this.overflow = true; throw new Error('Provider output exceeded the byte limit') }
    this.chunks.push(Buffer.from(`${channel}: `), Buffer.from(chunk))
  }
  snapshot(): Buffer { return Buffer.concat(this.chunks) }
}

/** A transport oracle, never an assistant-text or per-hook-ID cycle counter. */
export class ParentCompletionOracle {
  readonly callbacks = ['cycle-observer-a', 'cycle-observer-b']
  private cycles = new Map<string, { callbacks: Set<string>; active: boolean }>()
  private requests = new Set<string>()
  private assistantMessages = new Set<string>()
  private terminalIssued = false
  constructor(readonly sessionId: string, readonly rejectCorrection = false) {}
  observe(message: any): void {
    if (!this.rejectCorrection || message.type !== 'assistant') return
    assert.equal(message.session_id, this.sessionId)
    assert.ok(!message.parent_tool_use_id, 'Unexpected subagent observation')
    assert.ok(typeof message.message?.id === 'string' && message.message.id.length > 0)
    assert.ok(Array.isArray(message.message.content))
    assert.ok(message.message.content.every((block: any) => ['text', 'thinking', 'redacted_thinking'].includes(block.type)),
      'No tools permitted in terminal completion probe')
    this.assistantMessages.add(message.message.id)
    assert.ok(this.assistantMessages.size <= 2, 'Native provider continued after the correction budget')
  }
  callback(message: any): Record<string, unknown> {
    const request = message.request
    assert.equal(request?.subtype, 'hook_callback', 'Unexpected provider control request')
    assert.ok(this.callbacks.includes(request.callback_id), 'Unexpected callback identity')
    assert.equal(request.input?.hook_event_name, 'Stop')
    assert.equal(request.input?.session_id, this.sessionId)
    assert.ok(typeof request.tool_use_id === 'string' && request.tool_use_id.length > 0, 'No trusted cycle ID')
    assert.equal(typeof request.input.stop_hook_active, 'boolean')
    assert.ok(typeof message.request_id === 'string' && message.request_id.length > 0)
    assert.equal(this.requests.has(message.request_id), false, 'Replayed callback request')
    this.requests.add(message.request_id)
    let cycle = this.cycles.get(request.tool_use_id)
    if (!cycle) {
      assert.ok(this.cycles.size < 2, 'More than one correction attempt')
      cycle = { callbacks: new Set(), active: request.input.stop_hook_active }
      this.cycles.set(request.tool_use_id, cycle)
      assert.equal(cycle.active, this.cycles.size === 2, 'Unexpected correction-cycle flag')
    }
    assert.equal(cycle.active, request.input.stop_hook_active)
    assert.equal(cycle.callbacks.has(request.callback_id), false, 'Duplicate callback in one cycle')
    cycle.callbacks.add(request.callback_id)
    const first = [...this.cycles.keys()][0] === request.tool_use_id
    if (!first && this.rejectCorrection && request.callback_id === this.callbacks[0]) {
      this.terminalIssued = true
      return { continue: false, stopReason: 'Synthetic second rejection: correction budget exhausted.' }
    }
    return first && request.callback_id === this.callbacks[0]
      ? { decision: 'block', reason: 'Synthetic verification: reply with READY once more.' } : {}
  }
  complete(message: any): void {
    assert.equal(message.session_id, this.sessionId)
    assert.equal(message.is_error, false)
    assert.equal(message.subtype, 'success')
    assert.equal(this.cycles.size, 2)
    assert.ok([...this.cycles.values()].every((cycle) => cycle.callbacks.size === 2), 'Hooks did not share cycle IDs')
    if (this.rejectCorrection) {
      assert.equal(this.terminalIssued, true)
      assert.equal(this.assistantMessages.size, 2, 'Two bound native assistant messages required')
    }
  }
  terminalObservation(): Record<string, unknown> {
    return { secondRejectionIssued: this.terminalIssued, nativeAssistantMessages: this.assistantMessages.size }
  }
  summary(): unknown[] {
    return [...this.cycles.values()].map((cycle, index) => ({ ordinal: index + 1, callbacks: cycle.callbacks.size, correctionActive: cycle.active }))
  }
}
