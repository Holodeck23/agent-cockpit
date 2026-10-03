import { describe, expect, it } from 'vitest'
import { createDockActivity, parseActivity } from '../electron/dock-activity.ts'

function harness() {
  const icons: string[] = []
  const badges: string[] = []
  let tick: (() => void) | undefined
  const dock = createDockActivity({
    frames: ['f0', 'f1', 'f2'], rest: 'rest',
    setIcon: (image) => icons.push(image),
    setBadge: (text) => badges.push(text),
    setInterval: (run) => { tick = run; return 1 },
    clearInterval: () => { tick = undefined },
  })
  return { dock, icons, badges, tick: () => tick?.(), running: () => tick !== undefined }
}

describe('dock activity', () => {
  it('animates while anything works and rests the moment nothing does', () => {
    const h = harness()
    h.dock.update({ working: 2, needs: 0 })
    h.tick(); h.tick(); h.tick()
    expect(h.icons).toEqual(['f0', 'f1', 'f2', 'f0'])
    h.dock.update({ working: 1, needs: 0 }) // still working: no restart
    expect(h.icons).toHaveLength(4)
    h.dock.update({ working: 0, needs: 0 })
    expect(h.running()).toBe(false)
    expect(h.icons.at(-1)).toBe('rest')
    h.dock.update({ working: 0, needs: 0 })
    expect(h.icons.filter((i) => i === 'rest')).toHaveLength(1)
  })

  it('badges the Needs you count, cleared at zero, and only when it changes', () => {
    const h = harness()
    h.dock.update({ working: 0, needs: 2 })
    h.dock.update({ working: 1, needs: 2 })
    h.dock.update({ working: 0, needs: 1 })
    h.dock.update({ working: 0, needs: 0 })
    expect(h.badges).toEqual(['2', '1', ''])
  })

  it('stop rests the icon and clears the badge', () => {
    const h = harness()
    h.dock.update({ working: 1, needs: 3 })
    h.dock.stop()
    expect(h.running()).toBe(false)
    expect(h.icons.at(-1)).toBe('rest')
    expect(h.badges.at(-1)).toBe('')
  })

  it('accepts only two small non-negative integers from the page', () => {
    expect(parseActivity({ working: 1, needs: 0 })).toEqual({ working: 1, needs: 0 })
    for (const bad of [null, 'x', { working: -1, needs: 0 }, { working: 1.5, needs: 0 }, { working: 1 }, { working: 1, needs: 1e9 }]) {
      expect(parseActivity(bad)).toBeUndefined()
    }
  })
})

describe('dark Dock icon', () => {
  function themed() {
    const icons: string[] = []
    let tick: (() => void) | undefined
    const dock = createDockActivity({
      frames: ['f0', 'f1'], rest: 'rest', dark: { frames: ['d0', 'd1'], rest: 'drest' },
      setIcon: (image) => icons.push(image), setBadge: () => {},
      setInterval: (run) => { tick = run; return 1 }, clearInterval: () => { tick = undefined },
    })
    return { dock, icons, tick: () => tick?.() }
  }
  it('switches the resting icon with the theme, once per change', () => {
    const h = themed()
    h.dock.setDark(false)
    expect(h.icons).toEqual([])
    h.dock.setDark(true)
    h.dock.setDark(true)
    h.dock.setDark(false)
    expect(h.icons).toEqual(['drest', 'rest'])
  })
  it('keeps animating in the new look and rests in it', () => {
    const h = themed()
    h.dock.update({ working: 1, needs: 0 })
    h.dock.setDark(true)
    h.tick()
    h.dock.update({ working: 0, needs: 0 })
    expect(h.icons).toEqual(['f0', 'd1', 'drest'])
  })
})
