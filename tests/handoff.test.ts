import { describe, expect, it } from 'vitest'
import { claudeLaunchSchema } from '../server/agents/claude/flags.ts'
import { codexLaunchSchema } from '../server/agents/codex/launch.ts'
import { HANDOFF_BUDGET, buildHandoff } from '../server/threads/handoff.ts'
import type { StoredEvent } from '../server/threads/types.ts'

const user = (text: string): StoredEvent => ({ ts: '', event: { kind: 'user_text', text } })
const reply = (text: string): StoredEvent => ({ ts: '', event: { kind: 'assistant_text', messageId: 'm', text } })

/** A conversation of `turns` exchanges whose replies are `size` characters each. */
function conversation(turns: number, size: number): StoredEvent[] {
  return [user('TASK: port the parser to Rust'), ...Array.from({ length: turns }, (_, i) => [
    user(`question ${i}`), reply(`answer ${i} ${'x'.repeat(size)}`)]).flat()]
}

describe('switch handoff (J5)', () => {
  it('carries a long conversation in full, far past the old 24k cap', () => {
    const handoff = buildHandoff(conversation(40, 5_000), '/project')
    expect(handoff.length).toBeGreaterThan(200_000)
    expect(handoff).not.toContain('trimmed')
    expect(handoff).toContain('USER: TASK: port the parser to Rust')
    expect(handoff).toContain('answer 0 ')
    expect(handoff).toContain(`answer 39 ${'x'.repeat(5_000)}`)
  })

  it('past the budget keeps the opening request and the newest material, and says what it left out', () => {
    const handoff = buildHandoff(conversation(200, 5_000), '/project')
    expect(handoff.length).toBeLessThan(HANDOFF_BUDGET + 2_000)
    expect(handoff).toContain('USER: TASK: port the parser to Rust')
    expect(handoff).toContain('answer 199 ')
    expect(handoff).not.toContain('answer 0 ')
    expect(handoff).toMatch(/\[\d+ earlier messages left out to fit\]/)
    // The opening request comes before the gap, the newest material after it.
    expect(handoff.indexOf('TASK:')).toBeLessThan(handoff.indexOf('left out'))
    expect(handoff.indexOf('left out')).toBeLessThan(handoff.indexOf('answer 199 '))
  })

  it('never cuts a message in half at the trim point', () => {
    const handoff = buildHandoff(conversation(200, 5_000), '/project')
    const kept = handoff.split('\n').filter((line) => line.startsWith('PREVIOUS AGENT: answer'))
    for (const line of kept) expect(line).toMatch(new RegExp(`^PREVIOUS AGENT: answer \\d+ x{5000}$`))
  })

  it('fits a full-budget handoff, plus guidance, through every agent that takes a system prompt', () => {
    const seed = `${'g'.repeat(20_000)}\n\n${buildHandoff(conversation(200, 5_000), '/project')}`
    expect(claudeLaunchSchema.safeParse({ cwd: '/p', appendSystemPrompt: seed }).success).toBe(true)
    expect(codexLaunchSchema.safeParse({ cwd: '/p', developerInstructions: seed }).success).toBe(true)
  })
})
