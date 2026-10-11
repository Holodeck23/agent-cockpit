// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ThreadSummary } from '../../web/src/api.ts'

// u20-2: App feeds the Dock badge and useAttention from cockpit.threads, which holds every stored
// conversation, including those of a project the person removed from Cockpit ("Remove from Cockpit"
// keeps the conversations; the server only refuses while one is busy). A removed project is in no tab
// and no list, so nothing in the window can reply to or dismiss such a conversation, yet a question it
// ended on keeps the Dock badge up for good and any later change in it chimes and notifies.
// CORRECT behaviour: only conversations of projects the window still shows count or call for you.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  notify: vi.fn(),
  setActivity: vi.fn(),
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

const project = (path: string): Project => ({ path, name: path.split('/').pop(), color: 'blue', pinned: true, lastOpenedAt: '2026-10-10T09:00:00.000Z' }) as unknown as Project
const PROJECT = project('/work/alpha')

const GONE = '/work/removed'
function thread(id: string, status: ThreadSummary['status'], extra: Partial<ThreadSummary> = {}, projectPath = '/work/alpha'): ThreadSummary {
  return {
    meta: { id, title: id, projectPath }, status, preview: '', messageCount: 2, lastActivityAt: '2026-10-10T10:00:00.000Z', ...extra,
  } as unknown as ThreadSummary
}

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(): Promise<{ show: (threads: ThreadSummary[], projects?: Project[]) => void }> {
  const { App } = await import('../../web/src/App.tsx')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const show = (threads: ThreadSummary[], projects: Project[] = [PROJECT]): void => {
    hoisted.cockpit.threads = threads
    hoisted.projects = projects
    act(() => { root!.render(createElement(App, { page: { mode: 'local' } })) })
  }
  // The first render starts the onboarding probe; let it answer so the app shows its sections.
  show([])
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { show }
}

beforeEach(() => {
  vi.resetModules()
  hoisted.notify.mockClear()
  hoisted.setActivity.mockClear()
  hoisted.projects = [PROJECT]
  hoisted.cockpit = { threads: [], selectedId: undefined }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { show: false } }), { status: 200 })))
  document.hasFocus = () => true
  Object.defineProperty(window, 'cockpit', {
    configurable: true,
    value: {
      platform: 'darwin', setTheme: () => undefined, setActivity: hoisted.setActivity, notify: hoisted.notify, appVersion: async () => undefined,
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

const lastActivity = (): { working: number; needs: number } | undefined => hoisted.setActivity.mock.calls.at(-1)?.[0]
const asking = { awaiting: 'question', lastActivityAt: '2026-10-10T10:05:00.000Z' } as const

describe('conversations of a project removed from Cockpit', () => {
  it('still count when their project is shown (control)', async () => {
    const { show } = await mount()
    show([thread('shown', 'done', asking)])
    expect(lastActivity()).toEqual({ working: 0, needs: 1 })
  })

  it('do not hold the Dock badge up', async () => {
    const { show } = await mount()
    show([thread('shown', 'done'), thread('gone', 'done', asking, GONE)])
    expect(lastActivity()).toEqual({ working: 0, needs: 0 })
  })

  it('clear the badge when their project is removed', async () => {
    const { show } = await mount()
    const beta = project('/work/beta')
    show([thread('shown', 'done'), thread('other', 'done', asking, '/work/beta')], [PROJECT, beta])
    expect(lastActivity()).toEqual({ working: 0, needs: 1 })
    show([thread('shown', 'done'), thread('other', 'done', asking, '/work/beta')], [PROJECT]) // beta removed: its conversation stays stored
    expect(lastActivity()).toEqual({ working: 0, needs: 0 })
  })

  it('neither chime nor notify when they change, while a shown project still does', async () => {
    const { show } = await mount()
    show([thread('shown', 'working'), thread('gone', 'working', {}, GONE)])
    show([thread('shown', 'done'), thread('gone', 'done', asking, GONE)])
    expect(hoisted.notify.mock.calls.map((c) => (c[0] as { threadId: string }).threadId)).toEqual(['shown'])
  })
})
