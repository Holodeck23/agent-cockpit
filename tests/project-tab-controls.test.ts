// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Project } from '../web/src/api.ts'
import { useProjects, type Projects } from '../web/src/useProjects.ts'
import { ProjectTabBar } from '../web/src/components/ProjectTabBar.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const make = (name: string, pinOrder: number): Project => ({ path: `/fictional/${name}`, name, color: 'blue', pinned: true, pinOrder, lastOpenedAt: '2026-01-01' })

describe('project tab interactions', () => {
  let host: HTMLDivElement, root: Root, rows: Project[], projects: Projects
  const error = vi.fn()
  const Harness = () => { projects = useProjects([], error); return createElement(ProjectTabBar, { projects }) }
  const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  const click = async (name: string) => act(async () => button(name).click())
  const names = () => [...host.querySelectorAll('[role="tab"] .tab-name')].map((p) => p.textContent)
  beforeEach(async () => {
    localStorage.clear(); error.mockClear()
    rows = [make('Bakery', 1), make('Garden', 2), make('Notes', 3)]
    vi.spyOn(api, 'listProjects').mockImplementation(async () => structuredClone(rows))
    vi.spyOn(api, 'updateProjectTab').mockImplementation(async (path, patch) => {
      const found = rows.find((p) => p.path === path)!
      const next = { ...found, ...patch }
      rows = rows.map((p) => p.path === path ? next : p)
      return next
    })
    host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
    await act(async () => root.render(createElement(Harness)))
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
  it('closes inactive and active tabs, keeps all projects, and remembers closing the last tab across reload', async () => {
    await click('Close Notes tab')
    expect(projects!.active?.name).toBe('Bakery'); expect(names()).toEqual(['Bakery', 'Garden'])
    await click('Close Bakery tab')
    expect(projects!.active?.name).toBe('Garden'); expect(names()).toEqual(['Garden'])
    await click('Close Garden tab')
    expect(names()).toEqual([]); expect(projects!.active).toBeUndefined(); expect(projects!.all).toHaveLength(3)
    await act(async () => root.unmount()); root = createRoot(host)
    await act(async () => root.render(createElement(Harness)))
    expect(names()).toEqual([]); expect(projects!.active).toBeUndefined()
    await act(async () => projects!.select('/fictional/Notes'))
    expect(names()).toEqual(['Notes'])
  })
  it('changes an inactive tab colour without switching projects and offers keyboard ordering', async () => {
    await click('Project controls for Notes')
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio')
    await act(async () => host.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label$="purple"]')!.click())
    expect(api.updateProjectTab).toHaveBeenLastCalledWith('/fictional/Notes', { color: 'purple' })
    expect(projects!.active?.name).toBe('Bakery')
    expect(host.querySelector('.tab.tint-purple .tab-name')?.textContent).toBe('Notes')
    await click('Project controls for Notes')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((p) => p.textContent === 'Move left')!.click())
    expect(api.updateProjectTab).toHaveBeenLastCalledWith('/fictional/Notes', { before: '/fictional/Garden' })
  })
  it('keeps the tab and selection when a close fails, and surfaces the error', async () => {
    vi.mocked(api.updateProjectTab).mockRejectedValueOnce(new Error('Could not save projects'))
    await click('Close Bakery tab')
    expect(names()).toEqual(['Bakery', 'Garden', 'Notes']); expect(projects!.active?.name).toBe('Bakery')
    expect(error).toHaveBeenCalledWith('Could not save projects')
  })
  it('ignores a second close while the first save is pending', async () => {
    let release!: (value: Project) => void
    vi.mocked(api.updateProjectTab).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await click('Close Bakery tab')
    expect(button('Close Garden tab').disabled).toBe(true)
    await click('Close Garden tab')
    expect(api.updateProjectTab).toHaveBeenCalledTimes(1)
    rows = rows.map((p) => p.name === 'Bakery' ? { ...p, pinned: false } : p)
    await act(async () => release(rows[0]!))
    expect(names()).toEqual(['Garden', 'Notes'])
  })
  it('keeps a newer project selection while an earlier tab close finishes saving', async () => {
    let release!: (value: Project) => void
    vi.mocked(api.updateProjectTab).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await click('Close Bakery tab')
    await act(async () => projects!.select('/fictional/Notes'))
    rows = rows.map((p) => p.name === 'Bakery' ? { ...p, pinned: false } : p)
    await act(async () => release(rows[0]!))
    expect(projects!.active?.name).toBe('Notes')
    expect(names()).toEqual(['Garden', 'Notes'])
  })
  it('Escape dismisses controls and returns focus to their button', async () => {
    await click('Project controls for Garden')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button('Project controls for Garden'))
  })
})
