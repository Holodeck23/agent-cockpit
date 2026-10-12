// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../../web/src/components/FileTree.tsx'
import type { Project } from '../../web/src/api.ts'

// u29-1: FileTree's listing effect depends on the whole `project` object, but useProjects.refresh()
// replaces every Project object with fresh JSON (pinning a file calls it), and App passes
// projects.active down. Each refresh re-ran the effect: setListing(undefined) unmounted every row,
// the list went back to "Loading files…", the scroll position reset, and an open rename form lost
// what was typed.
// CORRECT behaviour: a new Project object for the same folder leaves the listing alone: no new
// request, and the rows stay mounted.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const projectNamed = (name: string, path = '/proj'): Project => ({ name, path, pinnedFiles: [] }) as unknown as Project

let root: Root | undefined
let host: HTMLElement | undefined
let listCalls: string[]

const listing = { entries: [{ kind: 'file', name: 'a.md', path: 'a.md' }, { kind: 'file', name: 'b.md', path: 'b.md' }], truncated: false }

beforeEach(() => {
  listCalls = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    listCalls.push(String(path))
    return new Response(JSON.stringify({ data: listing }), { status: 200 })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const render = (project: Project): void => {
  act(() => {
    root!.render(createElement(FileTree, {
      project, dirty: new Set<string>(), onOpen: () => undefined, onCreate: async () => true, onRenamed: () => undefined,
      onTrashed: () => undefined, onError: () => undefined, pins: [], onPins: () => undefined,
    }))
  })
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const rows = (): number => host!.querySelectorAll('.file-row').length

describe('u29-1: the file list survives a projects refresh', () => {
  it('a new Project object for the same folder does not reload or blank the list', async () => {
    render(projectNamed('Demo'))
    await settle()
    expect(rows()).toBe(2)
    expect(listCalls).toHaveLength(1)

    // useProjects.refresh(): same folder, brand-new object (here also with a changed pin list).
    render({ ...projectNamed('Demo'), pinnedFiles: ['a.md'] } as unknown as Project)
    expect(host!.textContent).not.toContain('Loading files')
    expect(rows()).toBe(2)
    await settle()
    expect(rows()).toBe(2)
    expect(listCalls).toHaveLength(1)
  })

  it('still lists the new folder when the project really changes', async () => {
    render(projectNamed('Demo'))
    await settle()
    render(projectNamed('Other', '/other'))
    await settle()
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]).toContain(encodeURIComponent('/other'))
  })
})
