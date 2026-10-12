// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ThreadSummary } from '../../web/src/api.ts'

// review of u01-1: the preload now holds a notification click ('cockpit:open-thread') until the page
// subscribes, and replays it synchronously inside onOpenThread(). A window that was closed and reopened
// subscribes while useCockpit has not read the thread list yet (threads is [] because nothing was read).
// App's handler found no such thread, returned, and the click was spent: the window came back without
// the conversation (docs/user/guide.md: clicking the notification opens that conversation).
// CORRECT behaviour: the id waits for the first thread list, then the conversation opens in its project.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  cockpit: { threads: [] as unknown[], threadsLoaded: false },
  selectThread: vi.fn(),
  selectProject: vi.fn(),
  projects: [] as unknown[],
  /** What the preload replays the moment the page subscribes (a click made while no window was open). */
  held: [] as string[],
  listeners: [] as Array<(threadId: string) => void>,
}))

vi.mock('../../web/src/useCockpit.ts', () => ({
  useCockpit: () => ({
    threads: hoisted.cockpit.threads, threadsLoaded: hoisted.cockpit.threadsLoaded, selectedId: undefined, detail: undefined, streaming: '', streams: {}, error: undefined,
    processes: [], remote: undefined, select: hoisted.selectThread, refresh: () => undefined, reportError: () => undefined,
  }),
}))
vi.mock('../../web/src/useProjects.ts', () => ({
  useProjects: () => ({
    refresh: async () => undefined, all: hoisted.projects, tabs: hoisted.projects, active: hoisted.projects[0], countsFor: () => ({ working: 0, needsYou: 0 }),
    select: hoisted.selectProject, reportError: () => undefined, open: async () => undefined, togglePin: async () => undefined, remove: async () => 0,
    setPinnedFiles: async () => undefined,
  }),
}))
vi.mock('../../web/src/useWorkspaces.ts', () => ({
  useWorkspaces: () => ({
    selection: { kind: 'primary', label: 'Main checkout', folder: '/work/alpha' }, worktrees: [], pending: [], hasWorktrees: false, list: [], health: {}, archived: [],
    guard: {}, select: () => undefined, refresh: async () => undefined,
  }),
}))
vi.mock('../../web/src/usePinnedDocuments.ts', () => ({ usePinnedDocuments: () => [] }))
vi.mock('../../web/src/components/FirstRun.tsx', () => ({ FirstRun: () => null }))
vi.mock('../../web/src/components/Workflows.tsx', () => ({ Workflows: () => null }))
vi.mock('../../web/src/components/Memory.tsx', () => ({ Memory: () => null }))
vi.mock('../../web/src/components/ConversationList.tsx', () => ({ ConversationList: () => null }))
vi.mock('../../web/src/components/ListResize.tsx', () => ({ ListResize: () => null, useListWidth: () => ({ width: 300, setWidth: () => undefined }) }))
vi.mock('../../web/src/components/Files.tsx', () => ({ Files: () => null }))
vi.mock('../../web/src/components/NewConversation.tsx', () => ({ NewConversation: () => null }))
vi.mock('../../web/src/components/ProjectTabBar.tsx', () => ({ ProjectTabBar: () => null }))
vi.mock('../../web/src/components/Processes.tsx', () => ({ Processes: () => null }))
vi.mock('../../web/src/components/SubNav.tsx', () => ({ SubNav: () => null }))
vi.mock('../../web/src/components/ReleaseNotes.tsx', () => ({ ReleaseNotes: () => null }))
vi.mock('../../web/src/components/TroubleshootingLink.tsx', () => ({ TroubleshootingLink: () => null }))
vi.mock('../../web/src/components/ThreadView.tsx', () => ({ ThreadView: () => null }))
vi.mock('../../web/src/components/AppearanceMenu.tsx', () => ({ AppearanceMenu: () => null }))
vi.mock('../../web/src/components/AppSettings.tsx', () => ({ AppSettings: () => null }))
vi.mock('../../web/src/components/FeedbackDialog.tsx', () => ({ FeedbackDialog: () => null }))
vi.mock('../../web/src/components/PhonePanel.tsx', () => ({ PhonePanel: () => null, PairingRequests: () => null }))
vi.mock('../../web/src/components/PhoneNotify.tsx', () => ({ PhoneNotify: () => null }))
vi.mock('../../web/src/components/WorkspaceSelector.tsx', () => ({ WorkspaceSelector: () => null }))
vi.mock('../../web/src/components/PreviewPane.tsx', () => ({ PreviewPane: () => null }))
vi.mock('../../web/src/components/BrowserPane.tsx', () => ({ BrowserPane: () => null }))
vi.mock('../../web/src/components/icons.tsx', () => ({ FeedbackIcon: () => null, Mark: () => null, SlidersIcon: () => null }))

const PROJECT = { path: '/work/alpha', name: 'alpha', color: 'blue', pinned: true, lastOpenedAt: '2026-10-10T09:00:00.000Z' } as unknown as Project

function thread(id: string): ThreadSummary {
  return {
    meta: { id, title: id, projectPath: '/work/alpha' }, status: 'done', preview: '', messageCount: 2, lastActivityAt: '2026-10-10T10:00:00.000Z',
  } as unknown as ThreadSummary
}

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(): Promise<{ show: (threads: ThreadSummary[], loaded: boolean) => void }> {
  const { App } = await import('../../web/src/App.tsx')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const show = (threads: ThreadSummary[], loaded: boolean): void => {
    hoisted.cockpit.threads = threads
    hoisted.cockpit.threadsLoaded = loaded
    act(() => { root!.render(createElement(App, { page: { mode: 'local' } })) })
  }
  // A reopened window's first render: the list has not been read yet.
  show([], false)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { show }
}

const click = (id: string): void => { act(() => { for (const listener of hoisted.listeners) listener(id) }) }

beforeEach(() => {
  vi.resetModules()
  hoisted.selectThread.mockClear()
  hoisted.selectProject.mockClear()
  hoisted.projects = [PROJECT]
  hoisted.cockpit = { threads: [], threadsLoaded: false }
  hoisted.held = []
  hoisted.listeners = []
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { show: false } }), { status: 200 })))
  document.hasFocus = () => true
  Object.defineProperty(window, 'cockpit', {
    configurable: true,
    value: {
      platform: 'darwin', setTheme: () => undefined, setActivity: () => undefined, notify: () => undefined, appVersion: async () => undefined,
      onShowReleaseNotes: () => () => undefined, onPreviewOpen: () => () => undefined, onFullScreen: () => () => undefined,
      // electron/preload.ts: what was held replays synchronously inside the subscribing call.
      onOpenThread: (listener: (threadId: string) => void) => {
        hoisted.listeners.push(listener)
        const due = hoisted.held
        hoisted.held = []
        for (const id of due) listener(id)
        return () => { hoisted.listeners = hoisted.listeners.filter((l) => l !== listener) }
      },
    },
  })
})

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
  delete (window as { cockpit?: unknown }).cockpit
})

describe('a notification click that reopens the window', () => {
  it('opens its conversation once the thread list has loaded', async () => {
    hoisted.held = ['b']
    const { show } = await mount()
    // Subscribed, replayed, and the list is still unread: nothing can be selected yet.
    expect(hoisted.selectThread).not.toHaveBeenCalled()
    show([thread('a'), thread('b')], true)
    expect(hoisted.selectThread).toHaveBeenCalledTimes(1)
    expect(hoisted.selectThread).toHaveBeenCalledWith('b')
    expect(hoisted.selectProject).toHaveBeenCalledWith('/work/alpha')
  })

  it('opens it once, not again on every later list', async () => {
    hoisted.held = ['b']
    const { show } = await mount()
    show([thread('a'), thread('b')], true)
    show([thread('a'), thread('b'), thread('c')], true)
    expect(hoisted.selectThread).toHaveBeenCalledTimes(1)
  })

  it('opens the latest of several held clicks', async () => {
    hoisted.held = ['a', 'b']
    const { show } = await mount()
    show([thread('a'), thread('b')], true)
    expect(hoisted.selectThread).toHaveBeenCalledTimes(1)
    expect(hoisted.selectThread).toHaveBeenCalledWith('b')
  })

  it('lets go of a conversation that is not in the loaded list instead of opening it when it later appears', async () => {
    hoisted.held = ['gone']
    const { show } = await mount()
    show([thread('a')], true)
    expect(hoisted.selectThread).not.toHaveBeenCalled()
    show([thread('a'), thread('gone')], true)
    expect(hoisted.selectThread).not.toHaveBeenCalled()
  })

  it('still opens a click made while the window is open at once (control)', async () => {
    const { show } = await mount()
    show([thread('a'), thread('b')], true)
    click('a')
    expect(hoisted.selectThread).toHaveBeenCalledWith('a')
    expect(hoisted.selectProject).toHaveBeenCalledWith('/work/alpha')
  })
})
