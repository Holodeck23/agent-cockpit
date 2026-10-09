import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { titleFromText } from '../server/threads/title.ts'

describe('titleFromText', () => {
  it('keeps a short first message as it is, on one line', () => {
    expect(titleFromText('Fix the login bug')).toBe('Fix the login bug')
    expect(titleFromText('  Fix the\n\nlogin   bug ')).toBe('Fix the login bug')
  })

  it('keeps a message of exactly 60 characters whole', () => {
    const sixty = 'a'.repeat(30) + ' ' + 'b'.repeat(29)
    expect(sixty).toHaveLength(60)
    expect(titleFromText(sixty)).toBe(sixty)
  })

  it('cuts a long message at a word boundary and adds an ellipsis (live case, 10-09)', () => {
    const title = titleFromText("Get this project's dev server running, check its log for errors, and tell me what it prints")
    expect(title).toBe("Get this project's dev server running, check its log for…")
    expect(title.length).toBeLessThanOrEqual(60)
  })

  it('never ends on punctuation before the ellipsis', () => {
    expect(titleFromText('Generate an image of a plain red circle on a white, clean background please now')).toBe('Generate an image of a plain red circle on a white, clean…')
  })

  it('cuts a very long single word where the room runs out', () => {
    const title = titleFromText('x'.repeat(200))
    expect(title).toBe(`${'x'.repeat(59)}…`)
    expect(title).toHaveLength(60)
  })
})

describe('a new conversation\'s title', () => {
  it('comes from the first message at a word boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-title-'))
    const launcher: Launcher = () => ({ agent: 'claude', alive: () => true, send() {}, interrupt() {}, respondApproval() {}, close: async () => {} })
    const manager = createThreadManager(createThreadStore(root), { launchers: { claude: launcher, codex: launcher } })
    const thread = manager.create({ projectPath: root, text: "Get this project's dev server running, check its log for errors, and tell me what it prints", settings: threadSettingsSchema.parse({}) })
    expect(thread.title).toBe("Get this project's dev server running, check its log for…")
    expect(manager.create({ projectPath: root, text: 'x', title: 'Named by the caller', settings: threadSettingsSchema.parse({}) }).title).toBe('Named by the caller')
  })
})
