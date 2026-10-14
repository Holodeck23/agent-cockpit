// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type AccountsView } from '../web/src/api.ts'
import { AccountChoice } from '../web/src/components/AccountChoice.tsx'
import { Composer } from '../web/src/components/Composer.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const accounts: AccountsView = {
  accounts: ['default-codex', 'work-codex'].map((id) => ({ id, agent: 'codex', label: id === 'default-codex' ? 'CLI default' : 'Work',
    mode: id === 'default-codex' ? 'default' : 'managed', isolation: id === 'default-codex' ? 'none' : 'CODEX_HOME', generation: 1, usageKey: `${id}#1` })),
  support: { codex: { profiles: true } },
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let host: HTMLDivElement, root: Root
let chosen = 'default-codex'
const selection = (codex: string) => ({ claude: 'default-claude', codex, antigravity: 'default-antigravity', opencode: 'default-opencode' })
beforeEach(() => {
  chosen = 'default-codex'
  localStorage.clear()
  vi.stubGlobal('fetch', () => Promise.reject(new Error('unused fixture route')))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(api, 'accounts').mockResolvedValue(accounts)
  vi.spyOn(api, 'listProjects').mockResolvedValue([{ path: '/synthetic/a', projectId: 'a' }, { path: '/synthetic/b', projectId: 'b' }] as never)
  vi.spyOn(api, 'projectAccounts').mockImplementation(async () => ({ selection: selection(chosen) }))
  vi.spyOn(api, 'selectAccount').mockImplementation(async (_id, _agent, id) => { chosen = id; return { selection: selection(chosen) } })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = async (element: ReturnType<typeof createElement>) => { await act(async () => root.render(element)) }
const select = () => host.querySelector<HTMLSelectElement>('[aria-label="Account for next message"]')!
const change = async (id: string) => { await act(async () => { select().value = id; select().dispatchEvent(new Event('change', { bubbles: true })) }) }
const compact = (projectPath = '/synthetic/a') => createElement(AccountChoice, { agent: 'codex', projectPath, compact: true, recheck: false })

it('shows checking while either lookup is pending, offers no sign-in, and can recover a failed lookup', async () => {
  const loading = deferred<AccountsView>()
  vi.mocked(api.accounts).mockReturnValueOnce(loading.promise)
  await render(compact())
  expect(select().disabled).toBe(true)
  expect(select().textContent).toContain('Checking account')
  expect(select().textContent).not.toContain('Add an account')
  await act(async () => loading.reject(new Error('Account service unavailable')))
  expect(select().disabled).toBe(true)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Account service unavailable')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(select().value).toBe('default-codex')
  expect(select().disabled).toBe(false)
  expect(select().selectedOptions[0]?.textContent).toContain('account unknown')
})

it('retains the previous account and explains a refused busy-project switch', async () => {
  await render(compact())
  vi.mocked(api.selectAccount).mockRejectedValueOnce(new Error('Stop the running conversation first.'))
  await change('work-codex')
  expect(select().value).toBe('default-codex')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stop the running conversation first.')
})

it('drops a late switch answer after navigating to another project', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.projectAccounts>>>()
  vi.mocked(api.selectAccount).mockReturnValueOnce(pending.promise)
  await render(compact())
  await change('work-codex')
  await render(compact('/synthetic/b'))
  expect(select().value).toBe('default-codex')
  await act(async () => pending.resolve({ selection: selection('work-codex') }))
  expect(select().value).toBe('default-codex')
})

it('keeps a mounted full picker and compact picker in sync, ignoring other projects', async () => {
  await render(createElement('div', {}, compact(), createElement(AccountChoice, { agent: 'codex', projectPath: '/synthetic/a', recheck: false })))
  await change('work-codex')
  expect(select().value).toBe('work-codex')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Account"]')?.value).toBe('work-codex')
  const before = vi.mocked(api.projectAccounts).mock.calls.length
  await act(async () => window.dispatchEvent(new CustomEvent('cockpit:account-changed', { detail: { projectPath: '/synthetic/b', agent: 'codex' } })))
  expect(api.projectAccounts).toHaveBeenCalledTimes(before)
})

it('blocks both Send and Enter during an account change, then disables switching during Send', async () => {
  const switching = deferred<Awaited<ReturnType<typeof api.projectAccounts>>>()
  const sending = deferred<void>()
  const submit = vi.fn(() => sending.promise)
  function Fixture() {
    const [pending, setPending] = useState(true)
    return createElement(Composer, { draftKey: 'account-fixture', placeholder: 'Message', initialDraft: 'do the work', picker: null, onSubmit: submit,
      accountPending: pending, account: (busy: boolean) => createElement(AccountChoice, {
        agent: 'codex', projectPath: '/synthetic/a', compact: true, recheck: false, disabled: busy, onPendingChange: setPending,
      }) })
  }
  await render(createElement(Fixture))
  vi.mocked(api.selectAccount).mockReturnValueOnce(switching.promise)
  await change('work-codex')
  const send = () => host.querySelector<HTMLButtonElement>('.send')!
  expect(send().disabled).toBe(true)
  await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(submit).not.toHaveBeenCalled()
  await act(async () => { chosen = 'work-codex'; switching.resolve({ selection: selection(chosen) }) })
  expect(send().disabled).toBe(false)
  await act(async () => send().click())
  expect(select().disabled).toBe(true)
  expect(submit).toHaveBeenCalledOnce()
  await act(async () => sending.resolve())
  expect(select().disabled).toBe(false)
})
