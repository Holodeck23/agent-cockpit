// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ThreadSummary } from '../../web/src/api.ts'

// u20-1: the focus callback App hands to useAttention is `document.hasFocus() ? cockpit.selectedId :
// undefined`. selectedId is not cleared when the section changes (only `section` changes), and the
// page shows one section at a time: with Files, Memory, Processes or Workflows open the selected
// conversation is not on screen. Its reply and its approval are still treated as "the one you are
// looking at", so they neither chime nor post a Mac notification.
// CORRECT behaviour: the conversation counts as looked-at only while the Conversations section shows it.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  notify: vi.fn(),
  requestAttention: vi.fn(),
  cockpit: { threads: [] as unknown[], selectedId: undefined as string | undefined },
  projects: [] as unknown[],
}))

vi.mock('../../web/src/useCockpit.ts', () => ({
  useCockpit: () => ({
    threads: hoisted.cockpit.threads, selectedId: hoisted.cockpit.selectedId, detail: undefined, streaming: '', streams: {}, error: undefined,
    processes: [], remote: undefined, select: () => undefined, refresh: () => undefined, reportError: () => undefined,
  }),
}))
vi.mock('../../web/src/useProjects.ts', () => ({
  useProjects: () => ({
    refresh: async () => undefined, all: hoisted.projects, tabs: hoisted.projects, active: hoisted.projects[0], countsFor: () => ({ working: 0, needsYou: 0 }),
    select: () => undefined, reportError: () => undefined, open: async () => undefined, togglePin: async () => undefined, remove: async () => 0,
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

function thread(id: string, status: ThreadSummary['status'], extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    meta: { id, title: id, projectPath: '/work/alpha' }, status, preview: '', messageCount: 2, lastActivityAt: '2026-10-10T10:00:00.000Z', ...extra,
  } as unknown as ThreadSummary
}

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(): Promise<{ show: (threads: ThreadSummary[], selectedId?: string) => void }> {
  const { App } = await import('../../web/src/App.tsx')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const show = (threads: ThreadSummary[], selectedId?: string): void => {
    hoisted.cockpit.threads = threads
    hoisted.cockpit.selectedId = selectedId
    act(() => { root!.render(createElement(App, { page: { mode: 'local' } })) })
  }
  // The first render starts the onboarding probe; let it answer so the app shows its sections.
  show([])
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { show }
}

const key = (digit: number) => new KeyboardEvent('keydown', { code: `Digit${digit}`, metaKey: true, altKey: true, bubbles: true, cancelable: true })
const goTo = (digit: number): void => { act(() => { window.dispatchEvent(key(digit)) }) }

beforeEach(() => {
  vi.resetModules()
  hoisted.notify.mockClear()
  hoisted.requestAttention.mockClear()
  hoisted.projects = [PROJECT]
  hoisted.cockpit = { threads: [], selectedId: undefined }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { show: false } }), { status: 200 })))
  document.hasFocus = () => true
  Object.defineProperty(window, 'cockpit', {
    configurable: true,
    value: {
      platform: 'darwin', setTheme: () => undefined, setActivity: () => undefined, requestAttention: hoisted.requestAttention,
      notify: hoisted.notify, appVersion: async () => undefined,
      onShowReleaseNotes: () => () => undefined, onPreviewOpen: () => () => undefined, onOpenThread: () => () => undefined, onFullScreen: () => () => undefined,
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

describe('attention for the selected conversation', () => {
  it('notifies about a conversation that is not the selected one (harness control)', async () => {
    const { show } = await mount()
    show([thread('a', 'working'), thread('b', 'working')], 'b')
    show([thread('a', 'needs_input', { lastActivityAt: '2026-10-10T10:05:00.000Z' }), thread('b', 'working')], 'b')
    expect(hoisted.notify).toHaveBeenCalledTimes(1)
    expect(hoisted.notify.mock.calls[0]?.[0]).toMatchObject({ threadId: 'a' })
    expect(hoisted.requestAttention).toHaveBeenCalledTimes(1)
    expect(document.title).toBe('Waiting on you · Cockpit')
  })

  it('still notifies when the focused conversation needs a decision', async () => {
    const { show } = await mount()
    show([thread('a', 'working')], 'a')
    show([thread('a', 'needs_input', { lastActivityAt: '2026-10-10T10:05:00.000Z' })], 'a')
    expect(hoisted.notify).toHaveBeenCalledTimes(1)
    expect(hoisted.notify.mock.calls[0]?.[0]).toMatchObject({ threadId: 'a' })
  })

  it('notifies about it when the person is on Files, where it is not on screen', async () => {
    const { show } = await mount()
    show([thread('a', 'working')], 'a')
    goTo(2) // ⌥⌘2: Files
    show([thread('a', 'needs_input', { lastActivityAt: '2026-10-10T10:05:00.000Z' })], 'a')
    expect(hoisted.notify).toHaveBeenCalledTimes(1)
    expect(hoisted.notify.mock.calls[0]?.[0]).toMatchObject({ threadId: 'a' })
  })

  it('notifies about a finished reply from Processes and a decision after returning to Conversations', async () => {
    const { show } = await mount()
    show([thread('a', 'working')], 'a')
    goTo(5) // ⌥⌘5: Processes
    show([thread('a', 'done', { lastActivityAt: '2026-10-10T10:05:00.000Z' })], 'a')
    expect(hoisted.notify).toHaveBeenCalledTimes(1)
    expect(hoisted.notify.mock.calls[0]?.[0]).toMatchObject({ threadId: 'a' })
    goTo(1) // ⌥⌘1: Conversations
    show([thread('a', 'working', { lastActivityAt: '2026-10-10T10:06:00.000Z' })], 'a')
    show([thread('a', 'needs_input', { lastActivityAt: '2026-10-10T10:07:00.000Z' })], 'a')
    expect(hoisted.notify).toHaveBeenCalledTimes(2)
  })
})
