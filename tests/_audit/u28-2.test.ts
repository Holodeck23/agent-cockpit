// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// u28-2: a reply's path:line link is kept by App after it is used, and Files unmounts whenever you leave
// the section or switch project. Every remount re-ran the old link: the file came back as the active tab,
// focus moved into the editor and the lines were selected again (in another project: a stranger's file).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => ({ open: vi.fn(async (_path: string) => {}) }))
vi.mock('../../web/src/useOpenFiles.ts', () => ({
  useOpenFiles: () => ({
    files: [], active: undefined, error: '', open: opened.open, create: vi.fn(), renamed: vi.fn(), removed: vi.fn(), setError: vi.fn(),
    close: vi.fn(), closeMany: vi.fn(), edit: vi.fn(), save: vi.fn(), reload: vi.fn(), overwrite: vi.fn(), saveCopy: vi.fn(),
  }),
}))
vi.mock('../../web/src/components/FileEditor.tsx', () => ({ FileEditor: () => null }))
vi.mock('../../web/src/components/FileTree.tsx', () => ({ FileTree: () => null }))
vi.mock('../../web/src/components/DocumentList.tsx', () => ({ DocumentList: () => null }))

const { Files } = await import('../../web/src/components/Files.tsx')

const project = { name: 'p', path: '/tmp/p' } as never
const reveal = (nonce: number, path = 'src/app.ts') => ({ target: { path, line: 40 }, nonce })
async function visit(r: ReturnType<typeof reveal>): Promise<void> {
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Files, { project, reveal: r, onAttach: () => {}, onPins: () => {} })) })
  await act(async () => { root.unmount() })
}

describe('a reply link opening Files', () => {
  beforeEach(() => { opened.open.mockClear() })

  it('opens its file once, however many times Files mounts afterwards', async () => {
    const link = reveal(1001)
    await visit(link)
    await visit(link)
    await visit(link)
    expect(opened.open).toHaveBeenCalledTimes(1)
    expect(opened.open).toHaveBeenCalledWith('src/app.ts')
  })

  it('opens the next link you click', async () => {
    await visit(reveal(2001, 'a.ts'))
    await visit(reveal(2002, 'b.ts'))
    expect(opened.open.mock.calls.map((c) => c[0])).toEqual(['a.ts', 'b.ts'])
  })
})
