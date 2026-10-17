import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NativeMemoryView, SkillsView } from '../web/src/api.ts'
import { MemoryChoice, SkillChoice, choiceState } from '../web/src/components/ProjectClaudeSetup.tsx'

// W13 Project Settings for the user's own Claude memory and skills: what is chosen, what is on
// offer, what was left out, and a choice that no longer loads (changed since, or another account).

const noop = (): void => undefined
const memorySelection = { id: 'm1', sourceAccountId: 'default-claude', sourceLabel: 'CLI default', destinationAccountId: 'acct-a',
  writePolicy: 'review' as const, fileCount: 3, selectedAt: '2026-10-17T08:00:00.000Z', current: true }
const memory = (patch: Partial<NativeMemoryView> = {}): string => renderToStaticMarkup(createElement(MemoryChoice, {
  view: { selection: null, sources: [{ accountId: 'default-claude', label: 'CLI default', available: true }, { accountId: 'acct-a', label: 'Work', available: false }], ...patch },
  accountId: 'acct-a', onChoose: noop, onRevoke: noop,
}))
const skillSelection = { id: 's1', sourceAccountId: 'default-claude', destinationAccountId: 'acct-a',
  counts: { skills: 2, commands: 1, agents: 0 }, selectedAt: '2026-10-17T08:00:00.000Z', current: true }
const offered = { sourceAccountId: 'default-claude', skills: ['deploy', 'review'], commands: ['standup'], agents: [],
  excluded: [{ path: 'skills/linked-one', reason: 'linked' as const, target: '/elsewhere/linked-one', includable: true },
    { path: 'skills/deploy/vendor', reason: 'linked' as const, target: '/elsewhere/vendor' }, { path: 'skills/gone', reason: 'linked' as const },
    { path: 'skills/huge/data.bin', reason: 'too-large' as const }],
  plugins: [{ key: 'vercel@market', name: 'vercel', version: '0.50.0', skills: 37, commands: 4, agents: 3, includable: true,
    leftOut: { hooks: true, connectors: true, manifestFields: [] } }, { key: 'playwright@market', name: 'playwright', includable: false, skills: 0, commands: 0, agents: 0 },
    { key: 'gone@market', name: 'gone', problem: 'its folder is missing' }] }
const skills = (patch: Partial<SkillsView> = {}, accountId = 'acct-a'): string => renderToStaticMarkup(createElement(SkillChoice, {
  view: { selection: null, offered, ...patch }, accountId, onChoose: noop, onRevoke: noop,
}))

describe('choiceState', () => {
  it('names each state, another account first', () => {
    expect(choiceState(null, 'a')).toBe('none')
    expect(choiceState({ destinationAccountId: 'a', current: true }, 'a')).toBe('current')
    expect(choiceState({ destinationAccountId: 'a', current: false }, 'a')).toBe('changed')
    expect(choiceState({ destinationAccountId: 'b', current: false }, 'a')).toBe('other-account')
    // Before the project's account is known, the choice is shown as it stands.
    expect(choiceState({ destinationAccountId: 'b', current: true }, undefined)).toBe('current')
  })
})

describe('Claude memory in Project Settings', () => {
  it('with nothing chosen, offers each source and disables one with no memory', () => {
    const html = memory()
    expect(html).toContain('Not loading any memory.')
    expect(html).toMatch(/<strong>CLI default<\/strong><\/span><button[^>]*>Use this memory<\/button>/)
    expect(html).toMatch(/No memory saved for this project yet<\/small><\/span><button[^>]*disabled=""[^>]*>Use this memory/)
    expect(html).not.toContain('Stop loading memory')
  })

  it('shows the current choice as chosen, with a way to stop it', () => {
    const html = memory({ selection: memorySelection })
    expect(html).toMatch(/Loading CLI default, 3 files, chosen/)
    expect(html).toContain('>Chosen</small>')
    expect(html).toContain('Stop loading memory')
  })

  it('says a changed memory needs another review, and offers it', () => {
    const html = memory({ selection: { ...memorySelection, current: false } })
    expect(html).toMatch(/role="alert"[^>]*>Changed since you chose it/)
    expect(html).toContain('will not start until you review it again')
    expect(html).toContain('Use the current memory')
    expect(html).not.toContain('>Chosen</small>')
  })

  it('says a choice for another account is not loaded', () => {
    const html = memory({ selection: { ...memorySelection, destinationAccountId: 'acct-old' } })
    expect(html).toContain('Chosen for a different Claude account, so it is not loaded')
    expect(html).not.toContain('>Chosen</small>')
  })
})

describe('your Claude skills in Project Settings', () => {
  it('with nothing chosen, shows what is on offer and what was left out, and why', () => {
    const html = skills()
    expect(html).toContain('Not loading your skills.')
    expect(html).toContain('On offer: 2 skills, 1 command, 0 agents.')
    expect(html).toContain('deploy, review')
    expect(html).toContain('Linked from elsewhere (1). Each is included only if you tick it, after checking where it points:')
    expect(html).toMatch(/<input type="checkbox"\/><span><strong>skills\/linked-one<\/strong><small>links to \/elsewhere\/linked-one/)
    expect(html).toContain('Not included (3):')
    expect(html).toMatch(/skills\/deploy\/vendor<\/strong><small>linked from elsewhere, not included until it can be reviewed/)
    expect(html).toMatch(/skills\/gone<\/strong><small>a link that points nowhere/)
    expect(html).toMatch(/skills\/huge\/data.bin<\/strong><small>over the size limit/)
    expect(html).toContain('>Use my skills</button>')
  })

  it('shows the current choice without offering to choose it again', () => {
    const html = skills({ selection: skillSelection })
    expect(html).toMatch(/Loading 2 skills, 1 command, 0 agents, chosen/)
    expect(html).not.toContain('Use my skills')
    expect(html).toContain('Stop loading my skills')
  })

  it('offers enabled plugins without their hooks or connectors, and says why others are not offered', () => {
    const html = skills()
    expect(html).toContain('Plugins you enabled (1). Only their skills, commands and agents can load here, never their hooks or connectors.')
    expect(html).toMatch(/<input type="checkbox"\/><span><strong>vercel 0.50.0<\/strong><small>37 skills, 4 commands, 3 agents; its hooks and connectors are left out/)
    expect(html).toContain('Plugins not offered (2):')
    expect(html).toMatch(/playwright<\/strong><small>no skills, commands or agents; its connectors do not load here/)
    expect(html).toMatch(/gone<\/strong><small>its folder is missing/)
  })

  it('a current choice with an included plugin ticks it and counts it', () => {
    const html = skills({ selection: { ...skillSelection, includedPlugins: ['vercel@market'] } })
    expect(html).toMatch(/Loading 2 skills, 1 command, 0 agents, with 1 plugin, chosen/)
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span><strong>vercel 0.50.0/)
  })

  it('a current choice with an included link ticks it and counts it', () => {
    const html = skills({ selection: { ...skillSelection, includedLinks: [{ path: 'skills/linked-one', target: '/elsewhere/linked-one' }] } })
    expect(html).toMatch(/Loading 2 skills, 1 command, 0 agents, with 1 linked entry, chosen/)
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span><strong>skills\/linked-one/)
    expect(html).not.toContain('Update my choice')
  })

  it('changed since chosen: review again', () => {
    const html = skills({ selection: { ...skillSelection, current: false } })
    expect(html).toMatch(/role="alert"[^>]*>Changed since you chose them/)
    expect(html).toContain('>Use the current version</button>')
    expect(html).toContain('Stop loading my skills')
  })

  it('a choice for another account can be made again for this one', () => {
    const html = skills({ selection: skillSelection }, 'acct-b')
    expect(html).toContain('Chosen for a different Claude account, so they are not loaded')
    expect(html).toContain('>Use my skills</button>')
  })

  it('when the profile cannot be read, says so and offers nothing to choose', () => {
    const html = skills({ offered: null, problem: 'Your skills could not be read' })
    expect(html).toMatch(/role="alert"[^>]*>Your skills could not be read/)
    expect(html).not.toContain('Use my skills')
  })
})
