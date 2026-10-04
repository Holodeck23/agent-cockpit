import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, planDrop, type DroppedItem } from '../web/src/composer-drop.ts'

const item = (over: Partial<DroppedItem>): DroppedItem => ({ name: 'x', type: '', size: 10, directory: false, ...over })

describe('dropping or pasting into the composer (I1)', () => {
  it('images become chips; files inside the project become references; outside, paths; folders, paths', () => {
    const plan = planDrop([
      item({ name: 'shot.png', type: 'image/png', path: '/Users/me/Desktop/shot.png' }),
      item({ name: 'a.ts', path: '/p/src/a.ts' }),
      item({ name: 'notes.txt', path: '/Users/me/notes.txt' }),
      item({ name: 'src', path: '/p/src', directory: true }),
      item({ name: 'Old Stuff', path: '/Users/me/Old Stuff', directory: true }),
    ], '/p', 0)
    expect(plan.images).toEqual([0])
    expect(plan.insert).toEqual(['@file:src%2Fa.ts', '/Users/me/notes.txt', 'src', '"/Users/me/Old Stuff"'])
    expect(plan.notes).toEqual([])
  })
  it('a pasted screenshot has no path and is still an image', () => {
    expect(planDrop([item({ name: 'image.png', type: 'image/png' })], '/p', 0).images).toEqual([0])
  })
  it('says what it left out: too big, too many, or a file with no path (browser, phone)', () => {
    const plan = planDrop([
      item({ name: 'huge.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }),
      item({ name: 'ninth.png', type: 'image/png' }),
      item({ name: 'doc.pdf', type: 'application/pdf' }),
    ], '/p', 7)
    expect(plan.images).toEqual([1])
    expect(planDrop([item({ name: 'more.png', type: 'image/png' })], '/p', 8).notes).toEqual(['more.png was left out: 8 images per message.'])
    expect(plan.notes).toEqual(['huge.png is over 5 MB.', 'doc.pdf: only images can be added here; drop files in the Mac app to add their paths.'])
  })
  it('an SVG or a folder named like an image is not an image', () => {
    const plan = planDrop([item({ name: 'logo.svg', type: 'image/svg+xml', path: '/p/logo.svg' }), item({ name: 'pics.png', type: 'image/png', path: '/p/pics.png', directory: true })], '/p', 0)
    expect(plan.images).toEqual([])
    expect(plan.insert).toEqual(['@file:logo.svg', 'pics.png'])
  })
  it('a sibling folder that shares the project name prefix is outside', () => {
    expect(planDrop([item({ name: 'b', path: '/p2/b' })], '/p', 0).insert).toEqual(['/p2/b'])
  })
})
