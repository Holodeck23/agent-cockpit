import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountChoice } from '../web/src/components/AccountChoice.tsx'

// Before the accounts and the project's choice arrive, nothing matches the box's value and a
// select shows its first option. That was "Add an account…", read as the project's account on a
// slow first launch (proof:accounts run 1, 2026-10-08). The first paint must say it is checking.
describe('the account box before its answers arrive', () => {
  const html = renderToStaticMarkup(createElement(AccountChoice, { agent: 'claude', projectPath: '/tmp/p' }))

  it('shows Checking…, selected, and is disabled', () => {
    expect(html).toMatch(/<option value="" selected="">Checking…<\/option>/)
    expect(html).toMatch(/<select[^>]*disabled=""/)
    expect(html).toMatch(/<select[^>]*aria-busy="true"/)
  })

  it('never presents Add an account… as the chosen account', () => {
    expect(html).not.toMatch(/<option value="__add" selected="">/)
  })
})
