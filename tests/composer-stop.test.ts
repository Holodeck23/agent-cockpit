// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type StoredEvent, type ThreadDetail, type ThreadStatus } from '../web/src/api.ts'
import { Composer } from '../web/src/components/Composer.tsx'
import { ThreadView } from '../web/src/components/ThreadView.tsx'
import { threadSettingsSchema } from '../server/threads/types.ts'
import type { AgentId } from '../server/agents/types.ts'
import type { ThreadWorkspace } from '../web/src/workspaces.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail = (status: ThreadStatus, agent: AgentId = 'antigravity'): ThreadDetail => ({
  meta: { id: 'stop-test', title: 'Stop test', projectPath: '/synthetic/project',
    settings: threadSettingsSchema.parse({ agent }), sessionId: 'session', sessionStarted: true,
    completed: false, createdAt: '2026-10-11T08:00:00Z', updatedAt: '2026-10-11T08:00:00Z' },
  status, events: [], transcriptPath: '/synthetic/messages.md', streaming: '',
})
const workspace = (id: string): ThreadWorkspace => ({
  scope: id, selectedId: id, folder: '/synthetic/worktree', target: { ok: true, workspaceId: id },
  currentLabel: id, showLabel: true, nameOf: (key) => key,
})

describe('Stop beside the message box', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline fixture')))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(api, 'interrupt').mockResolvedValue({})
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const stop = () => host.querySelector<HTMLButtonElement>('.composer-stop')
  const renderThread = async (data: ThreadDetail, selected?: ThreadWorkspace, onError = vi.fn()) => {
    await act(async () => root.render(createElement(ThreadView, {
      detail: data, streaming: '', processes: [], onError, workspace: selected,
    })))
  }

  it.each(['claude', 'codex', 'antigravity', 'opencode'] as const)('can stop %s with an empty draft', async (agent) => {
    await renderThread(detail('working', agent))
    expect(stop()?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true)
    await act(async () => stop()!.click())
    expect(api.interrupt).toHaveBeenCalledWith('stop-test', undefined)
  })

  it.each(['starting', 'needs_input'] as const)('can stop while %s', async (status) => {
    await renderThread(detail(status))
    expect(stop()).not.toBeNull()
    await act(async () => stop()!.click())
    expect(api.interrupt).toHaveBeenCalledTimes(1)
  })

  it.each(['idle', 'done', 'error'] as const)('hides Stop when %s', async (status) => {
    await renderThread(detail(status))
    expect(stop()).toBeNull()
  })

  it('keeps the draft and images, and can stop when sending is blocked', async () => {
    localStorage.setItem('draft:blocked-test', 'Keep my unsent follow-up')
    const onStop = vi.fn()
    const onSubmit = vi.fn(async () => {})
    await act(async () => root.render(createElement(Composer, {
      draftKey: 'blocked-test', placeholder: 'Message', picker: null, disabled: true,
      blocked: 'Workspace missing', confirmDestination: 'Other workspace', threadId: 'stop-test',
      prefill: { text: 'Keep my unsent follow-up', images: [{ file: 'kept.png' }] }, onStop, onSubmit,
    })))
    await act(async () => stop()!.click())
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')?.value).toBe('Keep my unsent follow-up')
    expect(localStorage.getItem('draft:blocked-test')).toBe('Keep my unsent follow-up')
    expect(host.querySelector('.image-chip')).not.toBeNull()
  })

  it('stops only the selected workspace and hides Stop when that workspace finishes', async () => {
    const data = detail('working')
    const events: StoredEvent[] = ['main', 'rose'].map((workspaceId) => ({
      workspaceId, ts: '2026-10-11T08:00:00Z', event: { kind: 'user_text', text: 'Hold this turn' },
    }))
    const meta = { ...data.meta, workspaceId: 'main', bindings: {
      rose: { agent: 'antigravity' as const, bindingId: 'rose-binding', sessionId: 'rose-session', sessionStarted: true, cursor: 0 },
    } }
    await renderThread({ ...data, meta, events }, workspace('rose'))
    expect(stop()?.getAttribute('aria-label')).toBe('Stop current turn in rose')
    await act(async () => stop()!.click())
    expect(api.interrupt).toHaveBeenCalledWith('stop-test', 'rose')
    await renderThread({ ...data, meta, events: [...events, {
      workspaceId: 'rose', ts: '2026-10-11T08:00:01Z', event: { kind: 'result', ok: false, stopped: true },
    }] }, workspace('rose'))
    expect(stop()).toBeNull()
    expect(host.querySelector('[aria-label="Stop"]')).not.toBeNull()
  })

  it('reports an interrupt failure through the existing conversation error handler', async () => {
    vi.mocked(api.interrupt).mockRejectedValue(new Error('Could not interrupt'))
    const onError = vi.fn()
    await renderThread(detail('working'), undefined, onError)
    await act(async () => stop()!.click())
    expect(onError).toHaveBeenCalledWith('Could not interrupt')
  })
})
